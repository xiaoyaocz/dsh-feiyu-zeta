/**
 * 出站处理器 — dsh session/event → QQ 消息发送
 *
 * 采用路由器模式：OutboundRouter 持有会话级状态（文本缓冲、工具调用记录），
 * 事件解析归一化在 events.ts，路由按事件类型分发到私有方法。
 */
import type { SessionManager, SessionRecord } from '../session/index.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import { type QQBotSender } from './outbound-buffer.ts';
import { type ToolsRegistryLike } from './tool-presenter.ts';
import type { DeliverablesDelivererLike } from './deliverables.ts';
import { type RawSessionEvent, type StreamDelta } from './events.ts';
export type { QQBotSender } from './outbound-buffer.ts';
export type { ToolsRegistryLike } from './tool-presenter.ts';
export { parseStreamFrame } from './events.ts';
/** 出站处理器签名（注册到 ctx.on('session/event')） */
export type OutboundHandler = (session: SessionLike, event: RawSessionEvent) => void;
/** 出站事件入口集合：durable 事件 + 实时流式帧 */
export interface OutboundHandlers {
    /** durable session 事件入口（注册到 ctx.on('session/event')） */
    routeSessionEvent(session: SessionLike, event: RawSessionEvent): void;
    /**
     * 实时流式帧入口（注册到 ctx.on('agent/assistant-stream', ..., { global: true })）。
     */
    routeStreamFrame(agentId: string, delta: StreamDelta): void;
    cancel(sessionId: string): void;
    awaitText(sessionId: string, signal?: AbortSignal): Promise<void>;
}
export interface AutomaticReplyPolicy {
    noteDelivered(record: SessionRecord, text: string): void;
    hasReplyDelivered(record: SessionRecord): boolean;
    hasDeliveredText(record: SessionRecord, text: string): boolean;
}
/** dsh Session 简化类型 */
export interface SessionLike {
    header: {
        id: string;
    };
}
/**
 * 创建出站事件处理器
 *
 * 返回 durable 事件与实时流式帧两个入口，分别注册到
 * ctx.on('session/event') 与 ctx.on('agent/assistant-stream', ..., { global: true })。
 * toolsRegistry 用于工具结果的结构化展示；deliverer 用于轮末投递 present 声明的交付文件。
 */
export declare function createOutboundHandler(manager: SessionManager, bot: QQBotSender, config: ImQQBotConfig, logger: Logger, toolsRegistry?: ToolsRegistryLike, deliverer?: DeliverablesDelivererLike, allowAutomatic?: (record: SessionRecord) => boolean, replyPolicy?: AutomaticReplyPolicy): OutboundHandlers;
//# sourceMappingURL=outbound.d.ts.map