/**
 * OutboundBuffer — 出站文本缓冲
 *
 * 收集流式 chunk，流式优先投递（StreamingWriter），降级为静态发送。
 * 独立文件便于单测。
 */
import type { InlineKeyboard } from '@tencent-connect/qqbot-nodejs';
import type { SessionRecord } from '../session/index.ts';
import type { Logger, ReplyTarget } from '../types.ts';
import { chunkMarkdownText } from './chunker.ts';
import { StreamingWriter } from './streaming-writer.ts';

/** 流式输出节流间隔(ms)：连续 chunk 累积后停顿该间隔才推送 */
const STREAM_THROTTLE_MS = 200;

/** QQ 流式会话（openStream 返回） */
export interface StreamSessionLike {
  /** SDK update may only queue the text; void is not a delivery receipt. */
  update(content: string): Promise<unknown>;
  /** QQ SDK complete returns the final DONE frame's MessageResponse. */
  complete(): Promise<unknown>;
  /** Cancel SDK throttling without publishing the pending text as DONE. */
  cancel?(): void;
}

/** QQ Bot 发送接口 */
export interface QQBotSender {
  sendMarkdown(target: ReplyTarget, content: string, opts?: { keyboard?: InlineKeyboard }): Promise<unknown>;
  openStream(target: ReplyTarget): StreamSessionLike;
}

export class OutboundBuffer {
  private buffer = '';
  private flushing = false;
  private readonly writer: StreamingWriter | null;
  private readonly record: SessionRecord;
  private readonly bot: QQBotSender;
  private readonly limit: number;
  private readonly logger: Logger;
  private readonly signal?: AbortSignal;
  private readonly onDelivered?: (text: string) => void;
  private readonly onAbort = (): void => { this.cancel(); };
  private cancelled = false;

  public constructor(
    record: SessionRecord,
    bot: QQBotSender,
    limit: number,
    logger: Logger,
    streamingEnabled: boolean,
    delivery?: { signal?: AbortSignal; onDelivered?(text: string): void },
  ) {
    this.record = { ...record, replyTarget: { ...record.replyTarget } };
    this.bot = bot;
    this.limit = limit;
    this.logger = logger;
    this.signal = delivery?.signal;
    this.onDelivered = delivery?.onDelivered;
    this.writer = streamingEnabled
      ? new StreamingWriter({ bot, target: this.record.replyTarget, logger, throttleMs: STREAM_THROTTLE_MS })
      : null;
    if (this.signal?.aborted) this.cancel();
    else this.signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  /** 追加文本增量 */
  public append(text: string): void {
    if (this.cancelled || this.signal?.aborted) return;
    this.buffer += text;
    this.writer?.append(text);
  }

  /** 获取当前累积文本 */
  public get text(): string {
    return this.buffer;
  }

  /** 重置累积文本（LLM 重试的新 attempt），流式会话保留由全量 update 重写 */
  public reset(): void {
    this.buffer = '';
    this.writer?.reset();
  }

  /** 发送所有累积文本：流式优先，降级静态 */
  public async flush(): Promise<void> {
    if (this.flushing || this.cancelled || this.signal?.aborted || !this.buffer.trim()) return;
    this.flushing = true;
    const text = this.buffer;

    try {
      if (this.writer) {
        await this.writer.finish();
        if (this.cancelled || this.signal?.aborted) return;
        // Unknown stream outcomes must not cause a second static message or
        // acknowledge text that never obtained a receipt in this attempt.
        if (!this.writer.shouldFallback) {
          const confirmed = this.writer.confirmedText;
          if (confirmed) this.onDelivered?.(confirmed);
          return;
        }
      }

      // 降级：静态发送（writer 不存在 or 流式失败）
      const chunks = chunkMarkdownText(text, this.limit);
      for (const chunk of chunks) {
        if (this.cancelled || this.signal?.aborted) return;
        await this.bot.sendMarkdown(this.record.replyTarget, chunk);
        if (this.cancelled || this.signal?.aborted) return;
        this.onDelivered?.(chunk);
      }
      this.onDelivered?.(text);
    } catch (err) {
      this.logger.error(`im-qqbot: flush failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.buffer = '';
      this.flushing = false;
      this.signal?.removeEventListener('abort', this.onAbort);
    }
  }

  /** 取消（异常/丢弃），中止流式并清空缓冲 */
  public cancel(): void {
    this.cancelled = true;
    this.signal?.removeEventListener('abort', this.onAbort);
    this.writer?.abort();
    this.buffer = '';
  }
}
