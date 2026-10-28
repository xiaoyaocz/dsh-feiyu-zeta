/**
 * 出站事件解析 — 将 dsh session/event 归一化为强类型
 *
 * 原始事件（ctx.on('session/event') 回调参数）是弱类型：
 *   { type: string, data: Record<string, unknown> }
 * 这里把可识别的事件解析为 discriminated union，未知类型或字段缺失返回 undefined。
 */
/** 原始 dsh 事件（弱类型，来自 ctx.on('session/event')） */
export interface RawSessionEvent {
    type: string;
    data: Record<string, unknown>;
}
/** turn/end 事件的 reason 结构（兼容 error/failure/顶层 message 三种形态） */
export interface TurnEndReason {
    kind?: string;
    error?: {
        message?: string;
        code?: string;
    };
    failure?: {
        message?: string;
        code?: string;
    };
    message?: string;
    code?: string;
}
/** assistant/chunk 事件（仅保留 text-delta） */
export interface ChunkEvent {
    type: 'assistant/chunk';
    text: string;
}
/** assistant/message 事件 */
export interface MessageEvent {
    type: 'assistant/message';
    content: Array<{
        type: string;
        text?: string;
    }>;
}
/** tool/call 事件 */
export interface ToolCallEvent {
    type: 'tool/call';
    callId: string;
    name: string;
    arguments: string;
}
/** tool/result 事件 */
export interface ToolResultEvent {
    type: 'tool/result';
    callId: string;
    error?: {
        name: string;
        code: string;
    };
    /** 原始 data 透传给 presenter 做结构化展示 */
    raw: Record<string, unknown>;
}
/** turn/end 事件 */
export interface TurnEndEvent {
    type: 'turn/end';
    reason: TurnEndReason;
}
/** present 工具声明的一个交付文件 */
export interface PresentedFileRef {
    /** 绝对路径，或相对 Session 工作目录的路径（仅历史声明） */
    path: string;
    /** 模型提供的可选说明 */
    description?: string;
}
/** deliverables/presented 事件（present 声明的交付文件，含嵌套调用） */
export interface DeliverablesPresentedEvent {
    type: 'deliverables/presented';
    turn: number;
    callId: string;
    files: PresentedFileRef[];
}
/** 出站事件联合类型 */
export type OutboundEvent = ChunkEvent | MessageEvent | ToolCallEvent | ToolResultEvent | TurnEndEvent | DeliverablesPresentedEvent;
/**
 * 解析原始事件为强类型
 *
 * 未知类型或缺失关键字段时返回 undefined，由调用方直接跳过。
 */
export declare function parseEvent(raw: RawSessionEvent): OutboundEvent | undefined;
/**
 * 从 turn/end reason 提取错误信息
 *
 * 兼容三种形态：error（新格式）、failure（旧格式）、顶层 message/code（最旧格式）。
 */
export declare function extractTurnError(reason: TurnEndReason): {
    code: string;
    message: string;
} | undefined;
/**
 * 归一化后的流式增量（`agent/assistant-stream` 瞬态帧，chunk 不进 session log）。
 */
export type StreamDelta = {
    kind: 'attempt-start';
    attemptId: string;
} | {
    kind: 'text-delta';
    attemptId: string;
    text: string;
};
/**
 * 解析 `agent/assistant-stream` 的 payload（对齐 @deepseek-ai/dsh-agent 的
 * AssistantStreamFrame 最小契约，避免硬依赖）。
 *
 * 只归一化两类帧：start（新 attempt）与 chunk 的 text-delta（文本增量）。
 * reasoning-delta / tool-call-delta 不进用户消息；end 帧不处理——收尾由 durable
 * `assistant/message` / `turn/end` 事件负责。未知形态返回 undefined。
 */
export declare function parseStreamFrame(raw: unknown): {
    agentId: string;
    delta: StreamDelta;
} | undefined;
//# sourceMappingURL=events.d.ts.map