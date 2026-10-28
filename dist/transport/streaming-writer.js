function hasReceipt(value) {
    return typeof value === 'object' && value !== null
        && 'id' in value && typeof value.id === 'string' && !!value.id.trim();
}
export class StreamingWriter {
    fullText = '';
    session = null;
    attempt = 0;
    updateAttempted = false;
    latestSubmission;
    queuedSubmission;
    confirmedSubmission;
    failed = false;
    finished = false;
    aborted = false;
    throttleTimer = null;
    chain = Promise.resolve();
    completion;
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /** 仅未尝试发送 update 时可静态降级；拒绝的网络请求也可能已经送达。 */
    get shouldFallback() {
        return !this.updateAttempted;
    }
    /** 当前 attempt 最后确有 QQ 消息回执的文字，不包含结果未知的尾部。 */
    get confirmedText() {
        return this.confirmedSubmission?.attempt === this.attempt ? this.confirmedSubmission.text : undefined;
    }
    get finalTextConfirmed() {
        return this.confirmedText !== undefined && this.confirmedText === this.fullText;
    }
    /** 累积全文（降级静态发送时使用） */
    get text() {
        return this.fullText;
    }
    /**
     * 重置累积文本（LLM 重试的新 attempt）。
     *
     * 保留已打开的流式会话与网络尝试标记：QQ 流式 update 是全量替换语义，
     * 新 attempt 的增量会把同一条消息整体重写，用户不会看到两条消息；
     * 历史回执不能确认重试后的文字，且不能因此静态重发整个新 attempt。
     */
    reset() {
        if (this.finished)
            return;
        this.fullText = '';
        this.attempt++;
        this.confirmedSubmission = undefined;
    }
    /** 追加增量文本，节流（throttle）后 update 全量 */
    append(delta) {
        if (this.finished)
            return;
        this.fullText += delta;
        // throttle：仅在无 pending timer 时启动，固定间隔 flush。
        // 不用 debounce（否则 chunk 持续到达时永远憋着，流式退化成一次性全量发送）
        if (this.throttleTimer === null) {
            this.throttleTimer = setTimeout(() => {
                this.throttleTimer = null;
                this.enqueue();
            }, this.deps.throttleMs);
        }
    }
    /** 结束：flush 最终文本 + complete 收尾 */
    async finish() {
        if (this.finished)
            return;
        this.finished = true;
        if (this.throttleTimer) {
            clearTimeout(this.throttleTimer);
            this.throttleTimer = null;
        }
        // 立即把最终累积文本入队（覆盖节流未触发的场景）
        this.enqueue();
        await this.chain;
        // 只要 session 存在就 complete（关闭流式消息，无论是否降级）
        await this.complete();
    }
    /** 中止（异常/取消）：阻止 SDK 继续发送待发帧。 */
    abort() {
        if (this.aborted)
            return;
        this.finished = true;
        this.aborted = true;
        if (this.throttleTimer) {
            clearTimeout(this.throttleTimer);
            this.throttleTimer = null;
        }
        // The installed QQ SDK's complete() publishes pending text. Its public
        // cancel() clears throttling without sending anything after a stop.
        if (this.session?.cancel) {
            try {
                this.session.cancel();
            }
            catch (err) {
                this.deps.logger.error(`im-qqbot: stream cancel failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        // An adapter without cancel cannot safely close the stream: complete may
        // publish pending text. Local timers/queued updates stay cancelled above.
    }
    complete() {
        if (!this.session)
            return Promise.resolve();
        const submitted = this.queuedSubmission;
        return this.completion ??= this.session.complete().then(receipt => {
            // SDK update() can resolve after merely scheduling a throttled flush.
            // complete() returns the DONE frame's real receipt. Confirm only its
            // last successfully queued text, never a failed or newer submission.
            if (hasReceipt(receipt) && submitted && submitted === this.latestSubmission)
                this.confirm(submitted);
        }, err => {
            this.deps.logger.error(`im-qqbot: stream complete failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
    confirm(submitted) {
        if (!this.aborted && submitted.attempt === this.attempt)
            this.confirmedSubmission = submitted;
    }
    /** 入队一次 update（串行，保证顺序） */
    enqueue() {
        this.chain = this.chain.then(() => this.pushUpdate());
    }
    /** 推送当前累积文本（首次 openStream + update 全量） */
    async pushUpdate() {
        if (this.aborted || this.failed || !this.fullText)
            return;
        const submitted = { attempt: this.attempt, text: this.fullText };
        // finish need not retry an identical update with an unknown outcome.
        if (this.latestSubmission?.attempt === submitted.attempt && this.latestSubmission.text === submitted.text)
            return;
        if (!this.session) {
            try {
                this.session = this.deps.bot.openStream(this.deps.target);
                this.deps.logger.debug(`im-qqbot: stream opened (chars=${this.fullText.length})`);
            }
            catch (err) {
                // openStream 失败：标记 failed 避免重复尝试，后续走降级静态
                this.failed = true;
                this.deps.logger.warn(`im-qqbot: openStream failed, fallback to static: ${err instanceof Error ? err.message : String(err)}`);
                return;
            }
        }
        this.updateAttempted = true;
        this.latestSubmission = submitted;
        try {
            const receipt = await this.session.update(submitted.text);
            this.queuedSubmission = submitted;
            // Alternate senders may expose update receipts. The installed QQ SDK
            // returns void, which is only queue acceptance and cannot open ACK gates.
            if (hasReceipt(receipt))
                this.confirm(submitted);
        }
        catch (err) {
            // update 失败：不标记 failed（session 已打开，finish 会 complete 关闭）
            this.deps.logger.warn(`im-qqbot: stream update failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
//# sourceMappingURL=streaming-writer.js.map