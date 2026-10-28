import { describe, expect, it } from 'vitest';
import { testDomainContext } from './test-support.ts';
import { defaultSettings, qqMemorySpace, ZetaState } from './state.ts';

describe('DSH-backed Zeta memory state', () => {
  it('keeps concurrent writes in one space and never crosses QQ scopes', async () => {
    const state = await ZetaState.open(testDomainContext());
    const alice = qqMemorySpace('bot', 'c2c', 'alice');
    const group = qqMemorySpace('bot', 'group', 'alice');
    await Promise.all(Array.from({ length: 12 }, (_, i) => state.setMemory(alice, { key: `fact${i}`, value: `喜欢${i}` })));
    expect(state.listMemory(alice)).toHaveLength(12);
    expect(state.listMemory(group)).toEqual([]);
    await state.setMemory(group, { key: 'culture', value: '群里喜欢简短回复' });
    expect(state.listMemory(alice, '简短')).toEqual([]);
    await state.close();
  });
  it('updates stable facts, rejects stale edits, deletes and bounds injection', async () => {
    const state = await ZetaState.open(testDomainContext());
    const first = await state.setMemory('one', { key: 'drink', value: '喜欢咖啡', pinned: true });
    await state.setMemory('one', { key: 'drink', value: '现在喜欢茶', expectedUpdatedAt: first.updatedAt });
    expect(state.listMemory('one')).toHaveLength(1);
    expect(state.listMemory('one', '茶')[0]?.value).toBe('现在喜欢茶');
    await expect(state.setMemory('one', { key: 'drink', value: '旧结果', expectedUpdatedAt: 'stale' })).rejects.toThrow('已变化');
    const settings = state.settings; settings.memory.injectChars = 0; await state.setSettings(settings);
    expect(state.memoryContext('one')).toBe('');
    expect(await state.deleteMemory('one', 'drink')).toBe(true);
    expect(await state.deleteMemory('one', 'drink')).toBe(false);
    await state.close();
  });
  it('retains bindings and memory across a reopened domain, and fences interrupted effects', async () => {
    const medium = new Map<string, Map<string, unknown>>();
    const first = await ZetaState.open(testDomainContext(medium));
    await first.bind({ key: 'qq:bot:c2c:a', appId: 'bot', scope: 'c2c', peerId: 'a', sessionId: 'old' });
    await first.setMemory('qq:bot:c2c:a', { key: 'name', value: '阿澈' });
    await first.putEffect('unfinished', { status: 'pending', kind: 'text', target: 'a', createdAt: 1 });
    await first.close();
    const next = await ZetaState.open(testDomainContext(medium));
    await next.bind({ key: 'qq:bot:c2c:a', appId: 'bot', scope: 'c2c', peerId: 'a', sessionId: 'new' });
    expect(next.binding('new')?.key).toBe(next.binding('old')?.key);
    expect(next.listMemory(next.binding('new')!.key)[0]?.value).toBe('阿澈');
    expect(next.effect('unfinished')?.status).toBe('unknown');
    await next.close();
  });
  it('defaults to no autonomous or paid speech work and validates settings', async () => {
    const state = await ZetaState.open(testDomainContext());
    expect(defaultSettings().life.enabled).toBe(false);
    expect(defaultSettings().speech.enabled).toBe(false);
    const settings = state.settings; settings.life.timeZone = 'not-a-zone';
    await expect(state.setSettings(settings)).rejects.toThrow();
    expect(state.settings.life.timeZone).toBe('Asia/Shanghai');
    await expect(state.setMemory('one', { key: 'bad', value: 'x'.repeat(601) })).rejects.toThrow();
    await state.close();
  });
});
