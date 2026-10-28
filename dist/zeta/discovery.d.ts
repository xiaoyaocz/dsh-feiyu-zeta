import type { Middleware, RawEventContext } from '@tencent-connect/qqbot-nodejs';
import type { AccessControlConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import type { UserObservation } from './state.ts';
export interface ConversationObservation {
    appId: string;
    scope: 'c2c' | 'group';
    peerId: string;
    title?: string;
    active?: boolean;
    seenAt?: number;
}
export interface ConversationObserver {
    observeConversation(observation: ConversationObservation): Promise<unknown>;
    observeUser?(observation: UserObservation): Promise<unknown>;
}
/** Observe accepted platform messages before mention gating, without creating an Agent. */
export declare function conversationDiscovery(appId: string, observer: ConversationObserver, logger: Logger): Middleware;
/** SDK rawEvent exposes lifecycle data as unknown: accept only a checked group_openid. */
export declare function observeGroupLifecycle(appId: string, observer: ConversationObserver, event: Pick<RawEventContext, 'eventType' | 'data' | 'receivedAt'>, access: AccessControlConfig): Promise<boolean>;
//# sourceMappingURL=discovery.d.ts.map