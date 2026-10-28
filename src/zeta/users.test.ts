import { afterEach, describe, expect, it } from 'vitest';
import { ZetaState } from './state.ts';
import { testDomainContext } from './test-support.ts';

const states: ZetaState[] = [];
afterEach(async () => { for (const state of states.splice(0)) await state.close(); });
async function open(persisted?: Map<string, Map<string, unknown>>) {
  const state = await ZetaState.open(testDomainContext(persisted)); states.push(state); return state;
}
describe('platform-observed QQ user directory', () => {
  it('discovers group members and private senders without making them administrators', async () => {
    const state = await open();
    await state.observeUser({ appId: 'bot', senderId: 'group-member', name: '群友甲', scope: 'group', peerId: 'group-a', seenAt: 10 });
    await state.observeUser({ appId: 'bot', senderId: 'private-user', name: '聊天朋友', scope: 'c2c', peerId: 'private-user', seenAt: 20 });
    expect(state.users('bot')).toEqual([
      { appId: 'bot', senderId: 'private-user', name: '聊天朋友', scope: 'c2c', peerId: 'private-user', lastSeenAt: 20 },
      { appId: 'bot', senderId: 'group-member', name: '群友甲', scope: 'group', peerId: 'group-a', lastSeenAt: 10 },
    ]);
    expect(state.settings.security.administrators).toEqual([]);
  });
  it('deduplicates by appId and senderId and keeps only the newest observed source and name', async () => {
    const state = await open();
    await Promise.all([
      state.observeUser({ appId: 'bot', senderId: 'same-user', name: '新名字', scope: 'group', peerId: 'new-group', seenAt: 50 }),
      state.observeUser({ appId: 'bot', senderId: 'same-user', name: '迟到的旧名字', scope: 'group', peerId: 'old-group', seenAt: 20 }),
      state.observeUser({ appId: 'other-bot', senderId: 'same-user', name: '另一个机器人看到的名字', scope: 'c2c', peerId: 'same-user', seenAt: 70 }),
    ]);
    expect(state.users('bot')).toEqual([{ appId: 'bot', senderId: 'same-user', name: '新名字', scope: 'group', peerId: 'new-group', lastSeenAt: 50 }]);
    expect(state.users('other-bot')).toHaveLength(1); expect(state.users()).toHaveLength(2);
    await state.observeUser({ appId: 'bot', senderId: 'same-user', scope: 'c2c', peerId: 'same-user', seenAt: 80 });
    expect(state.users('bot')[0]).toEqual({ appId: 'bot', senderId: 'same-user', name: '新名字', scope: 'c2c', peerId: 'same-user', lastSeenAt: 80 });
  });
  it('treats names as display data, omits missing names, validates source identity and returns detached records', async () => {
    const state = await open();
    await state.observeUser({ appId: 'bot', senderId: 'ordinary', name: '  管理员\u0000\n 显示名  ', scope: 'c2c', peerId: 'ordinary', seenAt: 1 });
    await state.observeUser({ appId: 'bot', senderId: 'anonymous', name: '  ', scope: 'group', peerId: 'group', seenAt: 2 });
    const view = state.users('bot');
    expect(view[0]).not.toHaveProperty('name'); expect(view[1]?.name).not.toMatch(/[\u0000-\u001f]/u);
    view[1]!.name = '本地修改返回值';
    expect(state.users('bot')[1]?.name).not.toBe('本地修改返回值');
    expect(state.settings.security.administrators).toEqual([]);
    for (const observation of [
      { appId: '', senderId: 'a', scope: 'group', peerId: 'g', seenAt: 1 },
      { appId: 'bot', senderId: 'fake identity', scope: 'group', peerId: 'g', seenAt: 1 },
      { appId: 'bot', senderId: 'a', scope: 'c2c', peerId: 'different-user', seenAt: 1 },
      { appId: 'bot', senderId: 'a', scope: 'group', peerId: 'g', seenAt: Number.NaN },
    ]) expect(() => state.observeUser(observation as never)).toThrow();
    expect(state.users('bot')).toHaveLength(2);
  });
  it('persists observed users across restart and roundtrips them in an authoritative backup snapshot', async () => {
    const storage = new Map<string, Map<string, unknown>>(), state = await open(storage);
    await state.observeUser({ appId: 'bot', senderId: 'group-member', name: '群成员', scope: 'group', peerId: 'group', seenAt: 123 });
    const snapshot = await state.snapshot(), reopened = await open(storage);
    expect(reopened.users()).toEqual(state.users());
    const target = await open(); await target.restoreSnapshot(snapshot);
    expect(target.users()).toEqual(state.users()); expect(await target.snapshot()).toEqual(snapshot);
  });
  it('accepts older snapshots without a users table and keeps legacy administrators for future observation', async () => {
    const state = await open(), settings = state.settings;
    await state.setSettings({ ...settings, security: { administrators: ['old-administrator'] } });
    const legacy: any = await state.snapshot(); delete legacy.tables.users;
    const target = await open(); await target.restoreSnapshot(legacy);
    expect(target.users()).toEqual([]); expect(target.settings.security.administrators).toEqual(['old-administrator']);
    await target.observeUser({ appId: 'bot', senderId: 'old-administrator', name: '终于收到消息', scope: 'group', peerId: 'known-group', seenAt: 99 });
    expect(target.users('bot')[0]?.name).toBe('终于收到消息'); expect(target.settings.security.administrators).toEqual(['old-administrator']);
  });
  it('backfills old private-chat routes on upgrade without inventing nicknames or group members', async () => {
    const storage = new Map<string, Map<string, unknown>>(), old = await open(storage);
    await old.bind({ appId: 'bot', scope: 'c2c', peerId: 'old-private-user', key: 'qq:bot:c2c:old-private-user', sessionId: 'private-session', title: '可由管理者修改的标题' });
    await old.observeConversation({ appId: 'bot', scope: 'c2c', peerId: 'old-private-user', title: '不是可信昵称', seenAt: 42 });
    await old.bind({ appId: 'bot', scope: 'group', peerId: 'old-group', key: 'qq:bot:group:old-group', sessionId: 'group-session', title: '群名不是群成员' });
    const lastSeenAt = old.conversations('bot').find(value => value.peerId === 'old-private-user')!.lastSeenAt;
    const upgraded = await open(storage);
    expect(upgraded.users('bot')).toEqual([{ appId: 'bot', senderId: 'old-private-user', scope: 'c2c', peerId: 'old-private-user', lastSeenAt }]);
    expect(upgraded.users('bot')[0]).not.toHaveProperty('name');
    const again = await open(storage); expect(again.users()).toEqual(upgraded.users());
  });
  it('does not overwrite an already observed name or newest group source during legacy backfill', async () => {
    const storage = new Map<string, Map<string, unknown>>(), state = await open(storage);
    await state.observeConversation({ appId: 'bot', scope: 'c2c', peerId: 'known-user', seenAt: 100 });
    await state.observeUser({ appId: 'bot', senderId: 'known-user', name: '实际群昵称', scope: 'group', peerId: 'actual-group', seenAt: 200 });
    const reopened = await open(storage);
    expect(reopened.users('bot')).toEqual([{ appId: 'bot', senderId: 'known-user', name: '实际群昵称', scope: 'group', peerId: 'actual-group', lastSeenAt: 200 }]);
  });
});
