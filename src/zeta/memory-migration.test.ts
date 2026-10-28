import { afterEach, describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { PUBLIC_SPACE, type MemoryEntry, ZetaState } from './state.ts';
import { testDomainContext } from './test-support.ts';

const opened: ZetaState[] = [];
afterEach(async () => { for (const state of opened.splice(0)) await state.close(); });
function entry(key: string, value: string, sourceSessionId = 'original-source'): MemoryEntry {
  return { key, value, tags: ['保留的标签'], pinned: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', sourceSessionId };
}
function storage(rows: Array<[string, unknown]>) { return new Map<string, Map<string, unknown>>([['memories', new Map(rows)]]); }
async function open(medium: Map<string, Map<string, unknown>>, ctx = testDomainContext(medium)) {
  const state = await ZetaState.open(ctx); opened.push(state); return state;
}
function failingContext(medium: Map<string, Map<string, unknown>>, phase: 'public-write' | 'cleanup', enabled = () => true): Context {
  const ctx = testDomainContext(medium);
  const service = ctx.storageDomain as unknown as { open(spec: unknown): Promise<any> };
  const original = service.open.bind(service);
  service.open = async spec => {
    const domain = await original(spec), tableFor = domain.table.bind(domain);
    return { ...domain, table(name: string) {
      const table = tableFor(name);
      if (name !== 'memories') return table;
      return { ...table,
        async put(key: string, value: unknown) { if (enabled() && phase === 'public-write' && key === PUBLIC_SPACE) throw new Error('Controlled public write failure'); return table.put(key, value); },
        async update(key: string, fn: (current: unknown) => unknown) { if (enabled() && phase === 'public-write' && key === PUBLIC_SPACE) throw new Error('Controlled public write failure'); return table.update(key, fn); },
        async delete(key: string) { if (enabled() && phase === 'cleanup' && key === 'legacy-b') throw new Error('Controlled old-row cleanup failure'); return table.delete(key); },
      };
    } };
  };
  return ctx;
}
describe('shared memory migration and recovery', () => {
  it('keeps public values first and retains conflicting old records with metadata and bounded deterministic source keys', async () => {
    const key = '长'.repeat(120), publicEntry = entry(key, '公共值', 'public-source');
    const privateEntry = entry(key, '旧私聊值', 'private-source'), groupEntry = entry(key, '旧群聊值', 'group-source');
    const duplicate = entry('共同事实', '两个旧库记录完全相同的事实');
    const medium = storage([
      [PUBLIC_SPACE, { revision: 9, entries: [publicEntry] }],
      ['qq:bot:c2c:a', { revision: 7, entries: [privateEntry, duplicate] }],
      ['qq:bot:group:g', { revision: 15, entries: [groupEntry, duplicate] }],
    ]);
    const state = await open(medium), all = state.listMemory('any-old-scope');
    expect(all).toHaveLength(4);
    expect(all.find(value => value.key === key)).toEqual(publicEntry);
    for (const original of [privateEntry, groupEntry]) {
      const migrated = all.find(value => value.value === original.value)!;
      expect(migrated.key).not.toBe(key); expect(migrated.key.length).toBeLessThanOrEqual(120);
      expect(migrated.key).toContain('~'); expect({ ...migrated, key: original.key }).toEqual(original);
    }
    expect(new Set(all.map(value => value.key)).size).toBe(4);
    const snapshot = await state.snapshot(), row = snapshot.tables.memories[PUBLIC_SPACE]!;
    expect(Object.keys(snapshot.tables.memories)).toEqual([PUBLIC_SPACE]);
    expect(row.revision).toBeGreaterThan(15);
    expect(Object.values(row.mergeReceipts!).map(receipt => [receipt.space, receipt.revision]).sort()).toEqual([['qq:bot:c2c:a', 7], ['qq:bot:group:g', 15]]);
    expect(state.listMemory('qq:bot:c2c:a')).toEqual(state.listMemory('qq:bot:group:g'));
    expect(state.memoryContext('ignored')).toContain('公共长期记忆');
  });

  it('is stable across repeated restarts and legacy backup restoration, without duplicating migrated entries or revisions', async () => {
    const medium = storage([
      ['legacy-a', { revision: 2, entries: [entry('同名', '甲')] }],
      ['legacy-b', { revision: 8, entries: [entry('同名', '乙')] }],
    ]);
    const state = await open(medium), first = await state.snapshot(), keys = state.listMemory('a').map(value => value.key);
    const restarted = await open(medium);
    expect(await restarted.snapshot()).toEqual(first); expect(restarted.listMemory('b').map(value => value.key)).toEqual(keys);
    const legacy = structuredClone(first);
    legacy.tables.memories = { 'legacy-a': { revision: 2, entries: [entry('同名', '甲')] }, 'legacy-b': { revision: 8, entries: [entry('同名', '乙')] } };
    const target = await open(storage([]));
    await target.restoreSnapshot(legacy); const once = await target.snapshot();
    await target.restoreSnapshot(legacy);
    expect(await target.snapshot()).toEqual(once); expect(target.listMemory(PUBLIC_SPACE)).toHaveLength(2);
  });

  it('copies entries beyond current limits without truncating historical values or source metadata', async () => {
    const old = Array.from({ length: 125 }, (_, index) => entry('旧事实' + index, index === 0 ? '长'.repeat(1500) : '事实' + index));
    const state = await open(storage([['old-space', { revision: 250, entries: old }]]));
    expect(state.listMemory(PUBLIC_SPACE)).toHaveLength(125);
    expect(state.listMemory('old-space').find(value => value.key === '旧事实0')?.value.length).toBe(1500);
    await expect(state.setMemory('new-space', { key: '新条目', value: '超过新增上限' })).rejects.toThrow('公共记忆已满');
    await state.setMemory('another-space', { key: '旧事实1', value: '仍可以主动修订已有事实' });
    expect(state.listMemory(PUBLIC_SPACE)).toHaveLength(125);
    expect((await state.snapshot()).tables.memories[PUBLIC_SPACE]?.mergeReceipts).toBeDefined();
  });

  it('leaves every old row intact if the complete public copy cannot be persisted', async () => {
    const medium = storage([['legacy-a', { revision: 4, entries: [entry('a', '原始甲')] }], ['legacy-b', { revision: 5, entries: [entry('b', '原始乙')] }]]);
    const before = structuredClone(medium.get('memories'));
    await expect(ZetaState.open(failingContext(medium, 'public-write'))).rejects.toThrow('Controlled public write failure');
    expect(medium.get('memories')).toEqual(before);
    const recovered = await open(medium);
    expect(recovered.listMemory(PUBLIC_SPACE).map(value => value.value).sort()).toEqual(['原始甲', '原始乙'].sort());
  });

  it('resumes an interrupted cleanup from committed receipts without copying the remaining source twice', async () => {
    const medium = storage([['legacy-a', { revision: 4, entries: [entry('同名', '原始甲')] }], ['legacy-b', { revision: 5, entries: [entry('同名', '原始乙')] }]]);
    await expect(ZetaState.open(failingContext(medium, 'cleanup'))).rejects.toThrow('Controlled old-row cleanup failure');
    const partial = structuredClone(medium.get('memories')!.get(PUBLIC_SPACE));
    expect((partial as { entries: MemoryEntry[] }).entries).toHaveLength(2); expect(medium.get('memories')!.has('legacy-b')).toBe(true);
    const recovered = await open(medium);
    expect((await recovered.snapshot()).tables.memories[PUBLIC_SPACE]).toEqual(partial);
    expect([...medium.get('memories')!.keys()]).toEqual([PUBLIC_SPACE]);
  });

  it('keeps a later public edit or deletion when an old receipted source remains after cleanup failure', async () => {
    const medium = storage([['legacy-b', { revision: 5, entries: [entry('原键', '旧内容')] }]]);
    await expect(ZetaState.open(failingContext(medium, 'cleanup'))).rejects.toThrow();
    const row = medium.get('memories')!.get(PUBLIC_SPACE) as { revision: number; entries: MemoryEntry[] };
    medium.get('memories')!.set(PUBLIC_SPACE, { ...row, revision: row.revision + 1, entries: [] });
    const recovered = await open(medium);
    expect(recovered.listMemory('legacy-b')).toEqual([]);
    expect([...medium.get('memories')!.keys()]).toEqual([PUBLIC_SPACE]);
  });

  it('persists a restored merged payload before removing existing legacy rows', async () => {
    let fail = false;
    const medium = storage([]), ctx = failingContext(medium, 'public-write', () => fail);
    const state = await open(medium, ctx);
    medium.get('memories')!.set('original-target-row', { revision: 4, entries: [entry('原目标数据', '原件尚未删除')] });
    const before = structuredClone(medium.get('memories'));
    const incoming = await state.snapshot();
    incoming.tables.memories = { 'legacy-a': { revision: 20, entries: [entry('旧备份', '完整原件')] } };
    fail = true;
    await expect(state.restoreSnapshot(incoming)).rejects.toThrow('Controlled public write failure');
    expect(medium.get('memories')).toEqual(before);
    fail = false;
    await state.restoreSnapshot(incoming);
    expect(state.listMemory(PUBLIC_SPACE)[0]).toEqual(entry('旧备份', '完整原件'));
    expect(Object.keys((await state.snapshot()).tables.memories)).toEqual([PUBLIC_SPACE]);
  });
});
