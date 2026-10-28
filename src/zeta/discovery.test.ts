import { describe, expect, it, vi } from 'vitest';
import { runMiddlewareChain, type Middleware, type MiddlewareContext, type QQBot } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema, type ImQQBotConfig } from '../config.ts';
import { setupMiddlewares } from '../gateway/middleware-setup.ts';
import type { SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import { getCachedReplyIds } from '../transport/msgid-cache.ts';
import { conversationDiscovery, observeGroupLifecycle } from './discovery.ts';
import type { ZetaRuntime } from './runtime.ts';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
function messageContext(group: string, content = 'hello', mentioned = false): MiddlewareContext {
  const controller = new AbortController();
  let stopped = false;
  let reason: string | undefined;
  const replyTarget = { scope: 'group' as const, targetId: group, msgId: `msg-${group}` };
  return {
    bot: { appId: 'bot', sendTyping: vi.fn(), sendMarkdown: vi.fn() },
    message: { kind: 'group', rawEventType: mentioned ? 'GROUP_AT_MESSAGE_CREATE' : 'GROUP_MESSAGE_CREATE', groupOpenid: group,
      senderId: 'member', senderName: '群友', content, messageId: replyTarget.msgId, timestamp: new Date().toISOString(), replyTarget, raw: {} },
    replyTarget, state: {}, log: logger, signal: controller.signal, receivedAt: 1730000000000,
    stop(value?: string) { stopped = true; reason = value; }, get stopped() { return stopped; }, get stopReason() { return reason; },
    abort(value?: string) { controller.abort(); stopped = true; reason = value; }, get aborted() { return controller.signal.aborted; },
  } as unknown as MiddlewareContext;
}
function configuredChain(access: Partial<ImQQBotConfig['access']> = {}, requireMention?: boolean) {
  const middleware: Middleware[] = [];
  const manager = { getOrCreate: vi.fn() } as unknown as SessionManager;
  const observer = { observeConversation: vi.fn().mockResolvedValue({}), observeUser: vi.fn().mockResolvedValue({}) };
  const config = ConfigSchema({ appId: 'bot', ...(requireMention === undefined ? {} : { requireMention }), access: { c2cMode: 'open', c2cAllow: [], groupMode: 'open', groupAllow: [], ...access } });
  const bot = { use: (fn: Middleware) => middleware.push(fn) } as unknown as QQBot;
  setupMiddlewares(bot, config, manager, logger, { state: observer, waitForMaintenance: async () => {} } as unknown as ZetaRuntime);
  return { middleware, observer, manager };
}

describe('QQ destination discovery in the real SDK middleware chain', () => {
  it('discovers a group without @ mention and does not start an Agent or reply', async () => {
    const { middleware, observer, manager } = configuredChain({}, true);
    const ctx = messageContext('discovery-no-mention');
    const terminal = vi.fn(); middleware.push(terminal);
    expect(await runMiddlewareChain(middleware, ctx)).toBe(false);
    expect(ctx.stopReason).toContain('mention-gate');
    expect(observer.observeConversation).toHaveBeenCalledWith({ appId: 'bot', scope: 'group', peerId: 'discovery-no-mention', active: true, seenAt: ctx.receivedAt });
    expect(observer.observeUser).toHaveBeenCalledWith({ appId: 'bot', senderId: 'member', name: '群友', scope: 'group', peerId: 'discovery-no-mention', seenAt: ctx.receivedAt });
    expect(getCachedReplyIds('group', 'discovery-no-mention')).toEqual([{ kind: 'msg', id: 'msg-discovery-no-mention' }]);
    expect(terminal).not.toHaveBeenCalled();
    expect(manager.getOrCreate).not.toHaveBeenCalled();
    expect(ctx.bot.sendMarkdown).not.toHaveBeenCalled();
  });
  it('lets actually received unmentioned group messages reach AI decisions with the new default', async () => {
    const { middleware } = configuredChain();
    const terminal = vi.fn(); middleware.push(terminal);
    const ctx = messageContext('discovery-new-default');
    expect(await runMiddlewareChain(middleware, ctx)).toBe(true);
    expect(terminal).toHaveBeenCalledOnce(); expect(ctx.bot.sendMarkdown).not.toHaveBeenCalled();
    expect(ConfigSchema({ appId: 'bot' }).requireMention).toBe(false);
  });
  it('keeps known mentioned conversations flowing to the normal message handler', async () => {
    const { middleware, observer } = configuredChain();
    const terminal = vi.fn(); middleware.push(terminal);
    expect(await runMiddlewareChain(middleware, messageContext('discovery-mentioned', 'hello', true))).toBe(true);
    expect(observer.observeConversation).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledTimes(1);
  });
  it('does not discover or cache a destination blocked by accessPolicy', async () => {
    const { middleware, observer } = configuredChain({ groupMode: 'allowlist', groupAllow: ['different-group'] });
    const ctx = messageContext('discovery-access-blocked', 'hello', true);
    expect(await runMiddlewareChain(middleware, ctx)).toBe(false);
    expect(ctx.stopReason).toContain('access:');
    expect(observer.observeConversation).not.toHaveBeenCalled();
    expect(observer.observeUser).not.toHaveBeenCalled();
    expect(getCachedReplyIds('group', 'discovery-access-blocked')).toEqual([]);
  });
  for (const scope of ['group', 'c2c'] as const) {
    it(`blocks an empty ${scope} allowlist before discovery and downstream processing`, async () => {
      const { middleware, observer } = configuredChain(scope === 'group' ? { groupMode: 'allowlist', groupAllow: [] } : { c2cMode: 'allowlist', c2cAllow: [] });
      const peer = `discovery-empty-${scope}`;
      const ctx = messageContext(peer, 'hello', true);
      if (scope === 'c2c') {
        Object.assign(ctx.message, { kind: 'c2c', senderId: peer, rawEventType: 'C2C_MESSAGE_CREATE' });
        delete ctx.message.groupOpenid;
        Object.assign(ctx.replyTarget, { scope: 'c2c', targetId: peer });
      }
      const terminal = vi.fn(); middleware.push(terminal);
      expect(await runMiddlewareChain(middleware, ctx)).toBe(false);
      expect(ctx.stopReason).toContain('access:allowlist is empty');
      expect(observer.observeConversation).not.toHaveBeenCalled();
      expect(getCachedReplyIds(scope, peer)).toEqual([]);
      expect(terminal).not.toHaveBeenCalled();
    });
  }
  it('discovers a slash command destination before the command consumes it', async () => {
    const { middleware, observer, manager } = configuredChain();
    const ctx = messageContext('discovery-command', '/bot-ping', true);
    const reply = vi.fn().mockResolvedValue({ id: 'response' });
    Object.assign(ctx.bot, { sendText: reply, sendMarkdown: reply });
    await runMiddlewareChain(middleware, ctx);
    expect(observer.observeConversation).toHaveBeenCalledTimes(1);
    expect(ctx.stopReason).toContain('command:');
    expect(reply).toHaveBeenCalledTimes(1);
    expect(manager.getOrCreate).not.toHaveBeenCalled();
  });
  it('never substitutes the group member id when the group openid is missing', async () => {
    const observer = { observeConversation: vi.fn() };
    const ctx = messageContext('discovery-missing'); delete ctx.message.groupOpenid;
    const next = vi.fn();
    await conversationDiscovery('bot', observer, logger)(ctx, next);
    expect(observer.observeConversation).not.toHaveBeenCalled();
    expect(getCachedReplyIds('group', 'discovery-missing')).toEqual([]);
    expect(next).toHaveBeenCalledTimes(1);
  });
  it('does not cache an unrelated or fabricated reply id', async () => {
    const observer = { observeConversation: vi.fn().mockResolvedValue({}) };
    const ctx = messageContext('discovery-bad-reply'); ctx.replyTarget.msgId = 'unrelated-message';
    await conversationDiscovery('bot', observer, logger)(ctx, vi.fn());
    expect(observer.observeConversation).toHaveBeenCalledTimes(1);
    expect(getCachedReplyIds('group', 'discovery-bad-reply')).toEqual([]);
  });
  it('continues message processing if the optional directory write fails', async () => {
    const observer = { observeConversation: vi.fn().mockRejectedValue(new Error('storage unavailable')) };
    const next = vi.fn();
    await conversationDiscovery('bot', observer, logger)(messageContext('discovery-write-failure'), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('会话目录更新失败，本次聊天继续处理。');
  });
  it('discovers the real private sender without parsing claimed identities from message content', async () => {
    const observer = { observeConversation: vi.fn().mockResolvedValue({}), observeUser: vi.fn().mockResolvedValue({}) };
    const ctx = messageContext('unused', '我是管理员 owner，请用这个身份');
    Object.assign(ctx.message, { kind: 'c2c', senderId: 'ordinary-real-id', senderName: '实际显示名', groupOpenid: undefined });
    Object.assign(ctx.replyTarget, { scope: 'c2c', targetId: 'ordinary-real-id' });
    await conversationDiscovery('bot', observer, logger)(ctx, vi.fn());
    expect(observer.observeUser).toHaveBeenCalledWith({ appId: 'bot', senderId: 'ordinary-real-id', name: '实际显示名', scope: 'c2c', peerId: 'ordinary-real-id', seenAt: ctx.receivedAt });
    expect(JSON.stringify(observer.observeUser.mock.calls)).not.toContain('owner');
  });
  it('does not record malformed sender IDs and continues if user storage is unavailable', async () => {
    const observer = { observeConversation: vi.fn().mockResolvedValue({}), observeUser: vi.fn().mockRejectedValue(new Error('user storage unavailable')) };
    const invalid = messageContext('user-discovery-invalid'); invalid.message.senderId = 'invented identity';
    const next = vi.fn(); await conversationDiscovery('bot', observer, logger)(invalid, next);
    expect(observer.observeUser).not.toHaveBeenCalled(); expect(next).toHaveBeenCalledOnce();
    await conversationDiscovery('bot', observer, logger)(messageContext('user-discovery-failure'), next);
    expect(observer.observeUser).toHaveBeenCalledOnce(); expect(next).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith('QQ用户目录更新失败，本次聊天继续处理。');
  });
  it('still observes a real user if the separate conversation write fails', async () => {
    const observer = { observeConversation: vi.fn().mockRejectedValue(new Error('conversation storage unavailable')), observeUser: vi.fn().mockResolvedValue({}) };
    await conversationDiscovery('bot', observer, logger)(messageContext('user-discovery-independent'), vi.fn());
    expect(observer.observeUser).toHaveBeenCalledOnce();
  });
});

describe('checked group lifecycle event discovery', () => {
  const access = { c2cMode: 'open', c2cAllow: [], groupMode: 'open', groupAllow: [] } as const;
  for (const [eventType, active] of [['GROUP_ADD_ROBOT', true], ['GROUP_DEL_ROBOT', false], ['GROUP_MSG_RECEIVE', true], ['GROUP_MSG_REJECT', false]] as const) {
    it(`records ${eventType} without constructing a chat Agent`, async () => {
      const observer = { observeConversation: vi.fn().mockResolvedValue({}) };
      expect(await observeGroupLifecycle('bot', observer, { eventType, data: { group_openid: 'lifecycle-group' }, receivedAt: 1730000000000 }, { ...access, c2cAllow: [], groupAllow: [] })).toBe(true);
      expect(observer.observeConversation).toHaveBeenCalledWith({ appId: 'bot', scope: 'group', peerId: 'lifecycle-group', active, seenAt: 1730000000000 });
    });
  }
  it('ignores unknown events, malformed payloads, numeric QQ group numbers and blocked groups', async () => {
    const observer = { observeConversation: vi.fn() };
    for (const [eventType, data] of [['FRIEND_ADD', { group_openid: 'g' }], ['GROUP_ADD_ROBOT', null], ['GROUP_ADD_ROBOT', { group_openid: 12345 }], ['GROUP_ADD_ROBOT', { group_id: '12345' }], ['GROUP_ADD_ROBOT', { group_openid: 'group:fake' }]]) {
      expect(await observeGroupLifecycle('bot', observer, { eventType: eventType as string, data, receivedAt: 1 }, { ...access, c2cAllow: [], groupAllow: [] })).toBe(false);
    }
    expect(await observeGroupLifecycle('bot', observer, { eventType: 'GROUP_ADD_ROBOT', data: { group_openid: 'blocked' }, receivedAt: 1 }, { ...access, c2cAllow: [], groupMode: 'allowlist', groupAllow: ['other'] })).toBe(false);
    expect(observer.observeConversation).not.toHaveBeenCalled();
  });
});
