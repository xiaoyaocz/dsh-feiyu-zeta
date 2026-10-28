import { cacheMsgId } from "../transport/msgid-cache.js";
const identifier = (value) => typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\s:\u0000]/u.test(value);
const timestamp = (value) => Number.isFinite(value) && value > 0 ? value : Date.now();
/** Observe accepted platform messages before mention gating, without creating an Agent. */
export function conversationDiscovery(appId, observer, logger) {
    return async (ctx, next) => {
        const message = ctx.message;
        if (identifier(appId) && (message.kind === 'c2c' || message.kind === 'group')) {
            const scope = message.kind;
            const peerId = scope === 'group' ? message.groupOpenid : message.senderId;
            if (identifier(peerId)) {
                // Cache only an internally consistent reply target from this real message.
                const reply = ctx.replyTarget;
                if (reply.scope === scope && reply.targetId === peerId && typeof reply.msgId === 'string' && reply.msgId.length > 0
                    && reply.msgId.length <= 1024 && !/[\s\u0000]/u.test(reply.msgId) && reply.msgId === message.messageId) {
                    cacheMsgId(scope, peerId, reply.msgId);
                }
                try {
                    const title = scope === 'c2c' && typeof message.senderName === 'string' ? message.senderName.trim().slice(0, 120) : undefined;
                    await observer.observeConversation({ appId, scope, peerId, ...(title ? { title } : {}), active: true, seenAt: timestamp(ctx.receivedAt) });
                }
                catch {
                    logger.warn('会话目录更新失败，本次聊天继续处理。');
                }
                if (identifier(message.senderId) && observer.observeUser) {
                    try {
                        const name = typeof message.senderName === 'string' ? message.senderName : undefined;
                        await observer.observeUser({ appId, senderId: message.senderId, scope, peerId, seenAt: timestamp(ctx.receivedAt), ...(name ? { name } : {}) });
                    }
                    catch {
                        logger.warn('QQ用户目录更新失败，本次聊天继续处理。');
                    }
                }
            }
        }
        await next();
    };
}
/** SDK rawEvent exposes lifecycle data as unknown: accept only a checked group_openid. */
export async function observeGroupLifecycle(appId, observer, event, access) {
    const active = event.eventType === 'GROUP_ADD_ROBOT' || event.eventType === 'GROUP_MSG_RECEIVE' ? true
        : event.eventType === 'GROUP_DEL_ROBOT' || event.eventType === 'GROUP_MSG_REJECT' ? false : undefined;
    if (active === undefined || !identifier(appId) || !event.data || typeof event.data !== 'object' || Array.isArray(event.data))
        return false;
    const peerId = event.data.group_openid;
    if (!identifier(peerId))
        return false;
    if (access.groupMode === 'disabled')
        return false;
    if (access.groupMode === 'allowlist' && !access.groupAllow.includes('*') && !access.groupAllow.includes(peerId))
        return false;
    await observer.observeConversation({ appId, scope: 'group', peerId, active, seenAt: timestamp(event.receivedAt) });
    return true;
}
//# sourceMappingURL=discovery.js.map