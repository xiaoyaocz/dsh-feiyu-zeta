import type { SessionManager } from '../session/index.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { ZetaRuntime } from '../zeta/runtime.ts';
/**
 * 处理 QQ 入站消息（已经过 SDK 中间件链）
 */
export declare function handleInbound(ctx: MiddlewareContext, manager: SessionManager, config: ImQQBotConfig, logger: Logger, zeta?: ZetaRuntime, batch?: MiddlewareContext[], history?: {
    excludeIds?: ReadonlySet<string>;
    include?: boolean;
}): Promise<void>;
//# sourceMappingURL=inbound.d.ts.map