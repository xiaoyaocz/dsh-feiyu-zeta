import type { Context } from '@deepseek-ai/cordis';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { describe, expect, it, vi } from 'vitest';
import { getHistoryStore, historyGroupKey } from '../features/history-store.ts';
import { previewSession, readConversation } from './conversations.ts';
import { ZetaRuntime } from './runtime.ts';
import { defaultSettings, ZetaState } from './state.ts';
import { testDomainContext } from './test-support.ts';

const signal = () => new AbortController().signal;
async function setup() {
  const inspect = vi.fn().mockResolvedValue({ events: [] });
  const ctx = Object.assign(testDomainContext(), { sessionController: { inspect } }) as unknown as Context;
  const state = await ZetaState.open(ctx);
  await state.bind({ key: 'qq:bot:c2c:alice', appId: 'bot', scope: 'c2c', peerId: 'alice', sessionId: 'private-session' });
  await state.bind({ key: 'qq:bot:group:friends', appId: 'bot', scope: 'group', peerId: 'friends', sessionId: 'group-session' });
  const runtime = new ZetaRuntime(ctx, state, 'bot');
  return { runtime, state, inspect, agent: { id: 'private-session' } };
}
const events = [
  { type: 'system/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'system-secret' }] } },
  { type: 'user/message', seq: 1, time: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '群里喜欢天文话题' }] } },
  { type: 'tool/result', seq: 2, time: 3, data: { content: [{ type: 'text', text: 'tool-secret' }] } },
  { type: 'assistant/message', seq: 3, time: 4, data: { message: { content: [{ type: 'thinking', text: 'hidden-reasoning' }, { type: 'text', text: '可以分享流星雨消息' }] } } },
  { type: 'user/message', seq: 4, time: 5, data: { source: { kind: 'schedule' }, content: [{ type: 'text', text: 'internal-wake' }] } },
] as unknown as SessionEvent[];

describe('QQ conversation directory and cross-session access', () => {
  it('migrates legacy bindings and settings without inventing a current Session among old histories', async () => {
    const medium = new Map<string, Map<string, unknown>>();
    const legacy = defaultSettings() as Partial<ReturnType<typeof defaultSettings>>;
    delete legacy.conversations;
    delete (legacy.life as Partial<NonNullable<typeof legacy.life>>).readTargets;
    medium.set('settings', new Map([['main', legacy]]));
    medium.set('bindings', new Map(['older', 'newer'].map(id => [id, { key: 'qq:bot:group:g', appId: 'bot', scope: 'group', peerId: 'g', sessionId: id }])));
    const state = await ZetaState.open(testDomainContext(medium));
    expect(state.settings.conversations).toEqual({ allowCrossSend: true, allowCrossRead: true });
    expect(state.settings.life.readTargets).toEqual([]);
    expect(state.conversations('bot')).toHaveLength(1);
    expect(state.conversations('bot')[0]?.sessionId).toBeUndefined();
    const runtime = new ZetaRuntime(testDomainContext(), state, 'bot');
    runtime.attachGateway({ manager: { currentSessionIdFor: () => 'actual-current', findByAgent: () => undefined } as never, sender: {} as never, mediaSender: {} as never });
    expect(runtime.conversations()[0]?.sessionId).toBe('actual-current');
    expect(state.bindings()).toHaveLength(2);
    await state.close();
  });
  it('keeps aliases and the current Session across observations and reopen', async () => {
    const medium = new Map<string, Map<string, unknown>>();
    const state = await ZetaState.open(testDomainContext(medium));
    await state.observeConversation({ appId: 'bot', scope: 'group', peerId: 'g' });
    await state.renameConversation('bot', 'group:g', '朋友群');
    await state.bind({ key: 'qq:bot:group:g', appId: 'bot', scope: 'group', peerId: 'g', sessionId: 'latest' });
    await state.observeConversation({ appId: 'bot', scope: 'group', peerId: 'g', active: false });
    await state.close();
    const reopened = await ZetaState.open(testDomainContext(medium));
    expect(reopened.conversations('bot')[0]).toMatchObject({ alias: '朋友群', sessionId: 'latest', active: false });
    await reopened.observeConversation({ appId: 'bot', scope: 'group', peerId: 'g', active: true });
    expect(reopened.conversations('bot')).toHaveLength(1);
    await reopened.close();
  });
  it('does not let an older observation reactivate a removed group', async () => {
    const state = await ZetaState.open(testDomainContext());
    await state.observeConversation({ appId: 'bot', scope: 'group', peerId: 'g', active: false, seenAt: 200 });
    await state.observeConversation({ appId: 'bot', scope: 'group', peerId: 'g', active: true, seenAt: 100 });
    expect(state.conversations('bot')[0]).toMatchObject({ active: false, lastSeenAt: 200 });
    await state.observeConversation({ appId: 'bot', scope: 'group', peerId: 'g', active: true, seenAt: 300 });
    expect(state.conversations('bot')[0]?.active).toBe(true);
    await state.close();
  });
  it('emits lossless directory values with absent optional fields and cleared aliases', async () => {
    const { runtime, state, agent } = await setup();
    await state.observeConversation({ appId: 'bot', scope: 'group', peerId: 'discovered' });
    await state.renameConversation('bot', 'group:discovered', '测试群');
    await state.renameConversation('bot', 'group:discovered', '');
    const values = runtime.contactTargets(agent);
    expect(values).toStrictEqual(JSON.parse(JSON.stringify(values)));
    await state.setMemory('qq:bot:c2c:alice', { key: 'manual', value: '手工记忆' });
    expect(state.listMemory('qq:bot:c2c:alice')).toStrictEqual(JSON.parse(JSON.stringify(state.listMemory('qq:bot:c2c:alice'))));
    await state.close();
  });
  it('allows private-to-group delivery through the existing sender and preserves read/send independence', async () => {
    const { runtime, state, agent } = await setup();
    const sendMarkdown = vi.fn().mockResolvedValue({ id: 'receipt' });
    runtime.attachGateway({ manager: { findByAgent: () => undefined } as never, sender: { sendMarkdown } as never, mediaSender: {} as never });
    expect(runtime.contactTargets(agent).map(value => value.target)).toContain('group:friends');
    await expect(runtime.sendText(agent, '大家好', 'group:friends', signal())).resolves.toMatchObject({ target: 'group:friends', messageId: 'receipt' });
    expect(sendMarkdown).toHaveBeenCalledWith({ scope: 'group', targetId: 'friends' }, '大家好');
    const settings = state.settings; settings.conversations.allowCrossSend = false; await state.setSettings(settings);
    expect(() => runtime.targetFor(agent, 'group:friends')).toThrow('跨会话发送');
    expect(runtime.readableConversation(agent, 'group:friends').peerId).toBe('friends');
    settings.conversations.allowCrossRead = false; await state.setSettings(settings);
    expect(() => runtime.readableConversation(agent, 'group:friends')).toThrow('跨会话读取');
    expect(runtime.targetFor(agent).peerId).toBe('alice');
    await state.close();
  });
  it('does not expose another bot, arbitrary DSH Session, unknown target or disabled QQ group', async () => {
    const { runtime, state, agent } = await setup();
    await state.bind({ key: 'qq:other:group:hidden', appId: 'other', scope: 'group', peerId: 'hidden', sessionId: 'other-bot' });
    expect(runtime.contactTargets(agent).map(value => value.target)).not.toContain('group:hidden');
    expect(() => runtime.targetFor(agent, 'group:hidden')).toThrow('未知QQ会话');
    expect(() => runtime.contactTargets({ id: 'project-agent' })).toThrow('可信QQ身份');
    runtime.configureAccess({ c2cMode: 'open', c2cAllow: [], groupMode: 'allowlist', groupAllow: [] });
    expect(runtime.contactTargets(agent).map(value => value.target)).toEqual(['c2c:alice']);
    expect(() => runtime.readableConversation(agent, 'group:friends')).toThrow('未知QQ会话');
    expect(() => runtime.targetFor({ id: 'other-bot' }, 'c2c:alice')).toThrow('投递目标');
    await state.close();
  });
  it('keeps life reading separate from contact permission, whitelist and quiet/cooldown limits', async () => {
    const { runtime, state } = await setup();
    const settings = state.settings;
    Object.assign(settings.life, { enabled: true, readTargets: ['group:friends'], allowContact: false });
    await state.setSettings(settings); await state.updateLife(value => ({ ...value, sessionId: 'life' }));
    const life = { id: 'life' };
    expect(runtime.readableConversation(life, 'group:friends').sessionId).toBe('group-session');
    expect(() => runtime.readableConversation(life, 'c2c:alice')).toThrow('可读取名单');
    expect(() => runtime.targetFor(life, 'group:friends')).toThrow('自主联系');
    Object.assign(settings.life, { targets: ['group:friends'], allowContact: true, quietStart: 0, quietEnd: 0 });
    await state.setSettings(settings);
    expect(runtime.targetFor(life, 'group:friends').peerId).toBe('friends');
    await state.updateLife(value => ({ ...value, contacts: { 'group:friends': Date.now() } }));
    expect(() => runtime.targetFor(life, 'group:friends')).toThrow('冷却');
    expect(runtime.readableConversation(life, 'group:friends')).toBeDefined();
    await state.close();
  });
  it('reads real dialogue without starting or messaging an Agent, and excludes synthetic inputs', async () => {
    const { runtime, state, inspect, agent } = await setup();
    inspect.mockResolvedValue({ events });
    const result = await readConversation(runtime, { target: 'group:friends' }, { agent, signal: signal() }) as { messages: Array<{ text: string }>; notice: string };
    expect(result.messages.map(value => value.text)).toEqual(['群里喜欢天文话题', '可以分享流星雨消息']);
    expect(inspect).toHaveBeenCalledWith('group-session', expect.any(AbortSignal));
    expect(JSON.stringify(result)).not.toMatch(/system-secret|tool-secret|hidden-reasoning|internal-wake/);
    const controller = new AbortController(); controller.abort();
    await expect(readConversation(runtime, { target: 'group:friends' }, { agent, signal: controller.signal })).rejects.toThrow();
    expect(inspect).toHaveBeenCalledTimes(1);
    await state.close();
  });
  it('bounds previews and supports exclusive sequence pagination', () => {
    const page = previewSession(events, 1, undefined, signal());
    expect(page.messages.map(value => value.seq)).toEqual([3]);
    expect(page.nextBeforeSeq).toBe(3);
    expect(previewSession(events, 1, page.nextBeforeSeq, signal()).messages.map(value => value.seq)).toEqual([1]);
    const long = [{ ...events[3], data: { message: { content: [{ type: 'text', text: 'x'.repeat(9000) }] } } }] as unknown as SessionEvent[];
    expect(previewSession(long, 20, undefined, signal()).messages[0]).toMatchObject({ truncated: true, text: 'x'.repeat(8000) });
  });
  it('can read a discovered group buffer before its first Agent exists', async () => {
    const { runtime, state, inspect, agent } = await setup();
    await state.observeConversation({ appId: 'bot', scope: 'group', peerId: 'new-group' });
    await getHistoryStore().append(historyGroupKey('bot', 'new-group'), { messageId: 'real-qq-message', senderId: 'member', content: '今晚有流星雨', timestamp: Date.now() }, 10);
    const result = await readConversation(runtime, { target: 'group:new-group' }, { agent, signal: signal() }) as { sessionId: string | null; pendingGroupMessages: Array<{ text: string }> };
    expect(result.sessionId).toBeNull();
    expect(result.pendingGroupMessages[0]?.text).toBe('今晚有流星雨');
    expect(inspect).not.toHaveBeenCalled();
    await getHistoryStore().clear?.(historyGroupKey('bot', 'new-group')); await state.close();
  });
});
