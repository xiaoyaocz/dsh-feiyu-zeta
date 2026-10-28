import type { ImQQBotConfig } from '../config.ts';
import type { SessionRecord } from '../session/index.ts';
import type { Logger } from '../types.ts';
import { type MediaSenderLike } from '../media/send-media.ts';
import type { PresentedFileRef } from './events.ts';
import type { QQBotSender } from './outbound-buffer.ts';
import type { ZetaRuntime } from '../zeta/runtime.ts';
/** 交付物投递器（outbound 路由只依赖此接口，便于测试注入） */
export interface DeliverablesDelivererLike {
    deliver(record: SessionRecord, files: PresentedFileRef[]): Promise<void>;
}
export declare class DeliverablesDeliverer implements DeliverablesDelivererLike {
    private readonly zeta?;
    private readonly sender;
    private readonly mediaBot;
    private readonly config;
    private readonly logger;
    constructor(sender: QQBotSender, mediaBot: MediaSenderLike, config: ImQQBotConfig, logger: Logger, zeta?: ZetaRuntime | undefined);
    /** 轮末投递一批声明文件：逐个发送，未送达的聚合为一条文字提示 */
    deliver(record: SessionRecord, files: PresentedFileRef[]): Promise<void>;
}
//# sourceMappingURL=deliverables.d.ts.map