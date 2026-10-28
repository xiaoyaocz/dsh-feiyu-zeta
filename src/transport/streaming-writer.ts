/**
 * StreamingWriter — QQ 流式文本写入器
 *
 * 边界条件设计：
 *   - 节流（throttle）：固定间隔 flush，避免每 token 发 HTTP，同时保证长文本分多次推送
 *   - 串行队列（chain）：保证 update 顺序，完成后区分真实回执与未知结果
 *   - 降级：仅尚未尝试 update 时可静态发送，网络结果未知不能自动重发全文
 *   - attempt 隔离：重试清空确认文字，旧回执不能证明新 attempt 已送达
 *   - 终态幂等（finished）：finish/abort 后忽略 append，重复 finish 不重复 complete
 *   - 中止（abort）：优先取消 SDK 待发帧，不把尚未发送的尾部作为 DONE 发出去
 */
import type { Logger, ReplyTarget } from '../types.ts';
import type { QQBotSender, StreamSessionLike } from './outbound-buffer.ts';

export interface StreamingWriterDeps {
  bot: QQBotSender;
  target: ReplyTarget;
  logger: Logger;
  /** 节流间隔（ms）：连续 append 累积后，停顿该间隔才 update */
  throttleMs: number;
}

interface Submission {
  attempt: number;
  text: string;
}

function hasReceipt(value: unknown): boolean {
  return typeof value === 'object' && value !== null
    && 'id' in value && typeof value.id === 'string' && !!value.id.trim();
}

export class StreamingWriter {
  private fullText = '';
  private session: StreamSessionLike | null = null;
  private attempt = 0;
  private updateAttempted = false;
  private latestSubmission?: Submission;
  private queuedSubmission?: Submission;
  private confirmedSubmission?: Submission;
  private failed = false;
  private finished = false;
  private aborted = false;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private completion?: Promise<void>;

  private readonly deps: StreamingWriterDeps;

  public constructor(deps: StreamingWriterDeps) {
    this.deps = deps;
  }

  /** 仅未尝试发送 update 时可静态降级；拒绝的网络请求也可能已经送达。 */
  public get shouldFallback(): boolean {
    return !this.updateAttempted;
  }

  /** 当前 attempt 最后确有 QQ 消息回执的文字，不包含结果未知的尾部。 */
  public get confirmedText(): string | undefined {
    return this.confirmedSubmission?.attempt === this.attempt ? this.confirmedSubmission.text : undefined;
  }

  public get finalTextConfirmed(): boolean {
    return this.confirmedText !== undefined && this.confirmedText === this.fullText;
  }

  /** 累积全文（降级静态发送时使用） */
  public get text(): string {
    return this.fullText;
  }

  /**
   * 重置累积文本（LLM 重试的新 attempt）。
   *
   * 保留已打开的流式会话与网络尝试标记：QQ 流式 update 是全量替换语义，
   * 新 attempt 的增量会把同一条消息整体重写，用户不会看到两条消息；
   * 历史回执不能确认重试后的文字，且不能因此静态重发整个新 attempt。
   */
  public reset(): void {
    if (this.finished) return;
    this.fullText = '';
    this.attempt++;
    this.confirmedSubmission = undefined;
  }

  /** 追加增量文本，节流（throttle）后 update 全量 */
  public append(delta: string): void {
    if (this.finished) return;
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
  public async finish(): Promise<void> {
    if (this.finished) return;
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
  public abort(): void {
    if (this.aborted) return;
    this.finished = true;
    this.aborted = true;

    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }

    // The installed QQ SDK's complete() publishes pending text. Its public
    // cancel() clears throttling without sending anything after a stop.
    if (this.session?.cancel) {
      try { this.session.cancel(); }
      catch (err) { this.deps.logger.error(`im-qqbot: stream cancel failed: ${err instanceof Error ? err.message : String(err)}`); }
    }
    // An adapter without cancel cannot safely close the stream: complete may
    // publish pending text. Local timers/queued updates stay cancelled above.
  }

  private complete(): Promise<void> {
    if (!this.session) return Promise.resolve();
    const submitted = this.queuedSubmission;
    return this.completion ??= this.session.complete().then(receipt => {
      // SDK update() can resolve after merely scheduling a throttled flush.
      // complete() returns the DONE frame's real receipt. Confirm only its
      // last successfully queued text, never a failed or newer submission.
      if (hasReceipt(receipt) && submitted && submitted === this.latestSubmission) this.confirm(submitted);
    }, err => {
      this.deps.logger.error(`im-qqbot: stream complete failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private confirm(submitted: Submission): void {
    if (!this.aborted && submitted.attempt === this.attempt) this.confirmedSubmission = submitted;
  }

  /** 入队一次 update（串行，保证顺序） */
  private enqueue(): void {
    this.chain = this.chain.then(() => this.pushUpdate());
  }

  /** 推送当前累积文本（首次 openStream + update 全量） */
  private async pushUpdate(): Promise<void> {
    if (this.aborted || this.failed || !this.fullText) return;
    const submitted: Submission = { attempt: this.attempt, text: this.fullText };
    // finish need not retry an identical update with an unknown outcome.
    if (this.latestSubmission?.attempt === submitted.attempt && this.latestSubmission.text === submitted.text) return;

    if (!this.session) {
      try {
        this.session = this.deps.bot.openStream(this.deps.target);
        this.deps.logger.debug(`im-qqbot: stream opened (chars=${this.fullText.length})`);
      } catch (err) {
        // openStream 失败：标记 failed 避免重复尝试，后续走降级静态
        this.failed = true;
        this.deps.logger.warn(
          `im-qqbot: openStream failed, fallback to static: ${err instanceof Error ? err.message : String(err)}`,
        );
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
      if (hasReceipt(receipt)) this.confirm(submitted);
    } catch (err) {
      // update 失败：不标记 failed（session 已打开，finish 会 complete 关闭）
      this.deps.logger.warn(
        `im-qqbot: stream update failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
