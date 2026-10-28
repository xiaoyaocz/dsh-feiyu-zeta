import type { Middleware, RawEventContext } from '@tencent-connect/qqbot-nodejs';
import type { AccessControlConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import { cacheMsgId } from '../transport/msgid-cache.ts';

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
}

const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\s:\u0000]/u.test(value);
const timestamp = (value: number): number => Number.isFinite(value) && value > 0 ? value : Date.now();

/** Observe accepted platform messages before mention gating, without creating an Agent. */
export function conversationDiscovery(appId: string, observer: ConversationObserver, logger: Logger): Middleware {
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
        } catch {
          logger.warn('会话目录更新失败，本次聊天继续处理。');
        }
      }
    }
    await next();
  };
}

/** SDK rawEvent exposes lifecycle data as unknown: accept only a checked group_openid. */
export async function observeGroupLifecycle(
  appId: string,
  observer: ConversationObserver,
  event: Pick<RawEventContext, 'eventType' | 'data' | 'receivedAt'>,
  access: AccessControlConfig,
): Promise<boolean> {
  const active = event.eventType === 'GROUP_ADD_ROBOT' || event.eventType === 'GROUP_MSG_RECEIVE' ? true
    : event.eventType === 'GROUP_DEL_ROBOT' || event.eventType === 'GROUP_MSG_REJECT' ? false : undefined;
  if (active === undefined || !identifier(appId) || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return false;
  const peerId = (event.data as Record<string, unknown>).group_openid;
  if (!identifier(peerId)) return false;
  if (access.groupMode === 'disabled') return false;
  if (access.groupMode === 'allowlist' && !access.groupAllow.includes('*') && !access.groupAllow.includes(peerId)) return false;
  await observer.observeConversation({ appId, scope: 'group', peerId, active, seenAt: timestamp(event.receivedAt) });
  return true;
}
