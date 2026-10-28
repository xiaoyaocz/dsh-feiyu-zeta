import { chunkMarkdownText } from "./chunker.js";
import { StreamingWriter } from "./streaming-writer.js";
/** 流式输出节流间隔(ms)：连续 chunk 累积后停顿该间隔才推送 */
const STREAM_THROTTLE_MS = 200;
export class OutboundBuffer {
    buffer = '';
    flushing = false;
    writer;
    record;
    bot;
    limit;
    logger;
    signal;
    onDelivered;
    onAbort = () => { this.cancel(); };
    cancelled = false;
    constructor(record, bot, limit, logger, streamingEnabled, delivery) {
        this.record = { ...record, replyTarget: { ...record.replyTarget } };
        this.bot = bot;
        this.limit = limit;
        this.logger = logger;
        this.signal = delivery?.signal;
        this.onDelivered = delivery?.onDelivered;
        this.writer = streamingEnabled
            ? new StreamingWriter({ bot, target: this.record.replyTarget, logger, throttleMs: STREAM_THROTTLE_MS })
            : null;
        if (this.signal?.aborted)
            this.cancel();
        else
            this.signal?.addEventListener('abort', this.onAbort, { once: true });
    }
    /** 追加文本增量 */
    append(text) {
        if (this.cancelled || this.signal?.aborted)
            return;
        this.buffer += text;
        this.writer?.append(text);
    }
    /** 获取当前累积文本 */
    get text() {
        return this.buffer;
    }
    /** 重置累积文本（LLM 重试的新 attempt），流式会话保留由全量 update 重写 */
    reset() {
        this.buffer = '';
        this.writer?.reset();
    }
    /** 发送所有累积文本：流式优先，降级静态 */
    async flush() {
        if (this.flushing || this.cancelled || this.signal?.aborted || !this.buffer.trim())
            return;
        this.flushing = true;
        const text = this.buffer;
        try {
            if (this.writer) {
                await this.writer.finish();
                if (this.cancelled || this.signal?.aborted)
                    return;
                // Unknown stream outcomes must not cause a second static message or
                // acknowledge text that never obtained a receipt in this attempt.
                if (!this.writer.shouldFallback) {
                    const confirmed = this.writer.confirmedText;
                    if (confirmed)
                        this.onDelivered?.(confirmed);
                    return;
                }
            }
            // 降级：静态发送（writer 不存在 or 流式失败）
            const chunks = chunkMarkdownText(text, this.limit);
            for (const chunk of chunks) {
                if (this.cancelled || this.signal?.aborted)
                    return;
                await this.bot.sendMarkdown(this.record.replyTarget, chunk);
                if (this.cancelled || this.signal?.aborted)
                    return;
                this.onDelivered?.(chunk);
            }
            this.onDelivered?.(text);
        }
        catch (err) {
            this.logger.error(`im-qqbot: flush failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        finally {
            this.buffer = '';
            this.flushing = false;
            this.signal?.removeEventListener('abort', this.onAbort);
        }
    }
    /** 取消（异常/丢弃），中止流式并清空缓冲 */
    cancel() {
        this.cancelled = true;
        this.signal?.removeEventListener('abort', this.onAbort);
        this.writer?.abort();
        this.buffer = '';
    }
}
//# sourceMappingURL=outbound-buffer.js.map