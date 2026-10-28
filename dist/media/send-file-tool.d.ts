import type { Context } from '@deepseek-ai/cordis';
import type { ImQQBotConfig } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import { type MediaSenderLike } from './send-media.ts';
import type { ZetaRuntime } from '../zeta/runtime.ts';
/** 工具名（qqbot 前缀避免与其他通道的同名工具冲突） */
export declare const SEND_FILE_TOOL_NAME = "qqbot_send_file";
/** 发送器与分类发送的共享实现见 send-media.ts（扩展名分发 + 白名单为单一事实源） */
export type { MediaSenderLike, MediaSendResult } from './send-media.ts';
/** 注册 qqbot_send_file 工具（tools 服务缺失时优雅降级，不阻断插件启动） */
export declare function registerSendFileTool(ctx: Context, bot: MediaSenderLike, manager: SessionManager, config: ImQQBotConfig, logger: Logger, zeta?: ZetaRuntime): void;
//# sourceMappingURL=send-file-tool.d.ts.map