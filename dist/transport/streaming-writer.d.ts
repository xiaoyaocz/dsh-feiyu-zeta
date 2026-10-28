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
import type { QQBotSender } from './outbound-buffer.ts';
export interface StreamingWriterDeps {
    bot: QQBotSender;
    target: ReplyTarget;
    logger: Logger;
    /** 节流间隔（ms）：连续 append 累积后，停顿该间隔才 update */
    throttleMs: number;
}
export declare class StreamingWriter {
    private fullText;
    private session;
    private attempt;
    private updateAttempted;
    private latestSubmission?;
    private queuedSubmission?;
    private confirmedSubmission?;
    private failed;
    private finished;
    private aborted;
    private throttleTimer;
    private chain;
    private completion?;
    private readonly deps;
    constructor(deps: StreamingWriterDeps);
    /** 仅未尝试发送 update 时可静态降级；拒绝的网络请求也可能已经送达。 */
    get shouldFallback(): boolean;
    /** 当前 attempt 最后确有 QQ 消息回执的文字，不包含结果未知的尾部。 */
    get confirmedText(): string | undefined;
    get finalTextConfirmed(): boolean;
    /** 累积全文（降级静态发送时使用） */
    get text(): string;
    /**
     * 重置累积文本（LLM 重试的新 attempt）。
     *
     * 保留已打开的流式会话与网络尝试标记：QQ 流式 update 是全量替换语义，
     * 新 attempt 的增量会把同一条消息整体重写，用户不会看到两条消息；
     * 历史回执不能确认重试后的文字，且不能因此静态重发整个新 attempt。
     */
    reset(): void;
    /** 追加增量文本，节流（throttle）后 update 全量 */
    append(delta: string): void;
    /** 结束：flush 最终文本 + complete 收尾 */
    finish(): Promise<void>;
    /** 中止（异常/取消）：阻止 SDK 继续发送待发帧。 */
    abort(): void;
    private complete;
    private confirm;
    /** 入队一次 update（串行，保证顺序） */
    private enqueue;
    /** 推送当前累积文本（首次 openStream + update 全量） */
    private pushUpdate;
}
//# sourceMappingURL=streaming-writer.d.ts.map