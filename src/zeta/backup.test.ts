import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { ZetaState } from './state.ts';
import { ZetaRuntime } from './runtime.ts';
import { testDomainContext } from './test-support.ts';
import { BackupService } from './backup.ts';
import { activateConfiguration } from './backup-config.ts';

vi.mock('./backup-config.ts', async original => ({ ...await original<typeof import('./backup-config.ts')>(), activateConfiguration: vi.fn().mockRejectedValue(new Error('configuration write fixture failed')) }));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.clearAllMocks(); });
async function setup() {
  const ctx = Object.assign(testDomainContext(), { agents: { get: () => undefined } }) as unknown as Context;
  const state = await ZetaState.open(ctx); cleanup.push(() => state.close());
  const runtime = new ZetaRuntime(ctx, state, 'bot', resolve('fixture-migrated-data'));
  return { ctx, state, runtime };
}

describe('complete plugin migration lifecycle', () => {
  it('roundtrips every authoritative plugin table without losing timestamps, revisions or effects', async () => {
    const { state } = await setup();
    await state.bind({ appId: 'bot', scope: 'group', peerId: 'g', key: 'qq:bot:group:g', sessionId: 'original-session' });
    await state.setMemory('qq:bot:group:g', { key: 'interest', value: '星空', pinned: true });
    await state.renameConversation('bot', 'group:g', '朋友群');
    await state.putEffect('done-action', { status: 'succeeded', kind: 'text', target: 'qq:bot:group:g', createdAt: 42, result: { messageId: 'real-receipt' } });
    await state.updateLife(value => ({ ...value, sessionId: 'life', summary: '实际进展', contacts: { 'group:g': 123 } }));
    const snapshot = await state.snapshot();
    const fresh = await ZetaState.open(testDomainContext()); cleanup.push(() => fresh.close());
    await fresh.restoreSnapshot(snapshot);
    expect(await fresh.snapshot()).toStrictEqual(snapshot);
    expect(fresh.listMemory('qq:bot:group:g')[0]?.pinned).toBe(true);
    expect(fresh.effect('done-action')?.result?.messageId).toBe('real-receipt');
  });
  it('cancels and drains in-flight UI writes before taking a snapshot', async () => {
    const { runtime } = await setup(); const controller = new AbortController();
    const finish = runtime.beginWriteOperation(controller);
    controller.signal.addEventListener('abort', () => { finish(); }, { once: true });
    let release!: () => void; const held = new Promise<void>(done => { release = done; });
    const operation = runtime.withMaintenance(async () => { expect(controller.signal.aborted).toBe(true); await held; return 'complete'; });
    expect(() => runtime.requireWritable()).toThrow('备份或迁移');
    release(); await expect(operation).resolves.toBe('complete');
    expect(() => runtime.requireWritable()).not.toThrow();
  });
  it.each(['memory', 'user'] as const)('rechecks conflicts after maintenance drains a %s writer that committed after the initial check', async kind => {
    const base = await realpath(tmpdir()); const temporary = await mkdtemp(join(base, 'zeta-backup-conflict-'));
    vi.stubEnv('DSH_HOME', temporary);
    cleanup.push(async () => {
      vi.unstubAllEnvs(); const rel = relative(base, temporary);
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Unsafe fixture cleanup');
      await rm(temporary, { recursive: true, force: true });
    });
    const ctx = Object.assign(testDomainContext(), { agents: { get: () => undefined } }) as unknown as Context;
    const state = await ZetaState.open(ctx); cleanup.push(() => state.close());
    const runtime = new ZetaRuntime(ctx, state, 'bot', join(temporary, 'blank-data'));
    const migrationWrite = vi.spyOn(state, 'setMigration'); const memesDispose = vi.fn(async () => {});
    const service = new BackupService(ctx, runtime, { dispose: memesDispose } as never);
    cleanup.push(() => service.dispose());
    const original = runtime.withMaintenance.bind(runtime); const controller = new AbortController();
    vi.spyOn(runtime, 'withMaintenance').mockImplementationOnce(async (work, lockAfter) => {
      // A normal UI write has passed requireWritable before the maintenance
      // gate opens. Its storage commit completes while maintenance drains it.
      const finish = runtime.beginWriteOperation(controller);
      const writer = (kind === 'memory'
        ? state.setMemory('self:zeta', { key: 'arrived-during-restore', value: '必须保留的并发写入' })
        : state.observeUser({ appId: 'bot', senderId: 'new-member', scope: 'group', peerId: 'group', seenAt: 123 })).finally(finish);
      const result = original(work, lockAfter); await writer;
      return result;
    });
    const stage = { token: randomUUID(), createdAt: Date.now(), preview: { canRestore: true }, manifestDigest: 'fixture-digest', manifest: { id: randomUUID(), state: await state.snapshot() } };
    await expect((service as unknown as { restore(stage: unknown): Promise<unknown> }).restore(stage)).rejects.toThrow('目标插件已有聊天、用户目录、记忆或活动数据');
    expect(controller.signal.aborted).toBe(true); expect(migrationWrite).not.toHaveBeenCalled(); expect(memesDispose).not.toHaveBeenCalled();
    expect(state.migration).toBeUndefined();
    if (kind === 'memory') expect(state.listMemory('self:zeta')).toMatchObject([{ key: 'arrived-during-restore', value: '必须保留的并发写入' }]);
    else expect(state.users('bot')).toMatchObject([{ senderId: 'new-member', scope: 'group', lastSeenAt: 123 }]);
    expect(() => runtime.requireWritable()).not.toThrow();
  });
  it('rejects a signalled Agent waiter after a successful restore requests restart', async () => {
    const { runtime } = await setup(); let release!: () => void;
    const held = new Promise<void>(done => { release = done; });
    const operation = runtime.withMaintenance(async () => { await held; }, true);
    const waiter = runtime.waitForMaintenance(new AbortController().signal);
    const rejection = expect(waiter).rejects.toThrow('重启DSH');
    release(); await operation; await rejection;
  });
  it('keeps an interrupted final configuration commit persistently locked', async () => {
    const { state, runtime } = await setup();
    await state.setMigration({ backupId: 'backup', backupDigest: 'digest', status: 'complete', dataRoot: resolve('different-import-root'), workspaceRoot: resolve('workspaces'), restartRequired: true, qqPaused: true, pathMappings: {} });
    expect(() => runtime.requireWritable()).toThrow();
    await expect(runtime.waitForMaintenance()).rejects.toThrow('继续恢复');
  });
  it('retains restored group buffers through HMR/restart until that group is consumed', async () => {
    const medium = new Map<string, Map<string, unknown>>(); const state = await ZetaState.open(testDomainContext(medium));
    await state.setMigration({ backupId: 'backup', status: 'complete', dataRoot: resolve('data'), workspaceRoot: resolve('workspaces'), restartRequired: true, qqPaused: true, pathMappings: {}, groupBuffers: [{ appId: 'bot', peerId: 'first', entries: [] }, { appId: 'bot', peerId: 'second', entries: [] }] });
    await state.close();
    const reopened = await ZetaState.open(testDomainContext(medium)); cleanup.push(() => reopened.close());
    expect(reopened.migration?.groupBuffers).toHaveLength(2);
    await reopened.consumeMigrationGroup('bot', 'first');
    expect(reopened.migration?.groupBuffers).toEqual([{ appId: 'bot', peerId: 'second', entries: [] }]);
  });
  it('lets the owner retry activation when the native profile write fails', async () => {
    const { ctx, state, runtime } = await setup();
    await state.setMigration({ backupId: 'backup', status: 'complete', dataRoot: runtime.dataDir, workspaceRoot: resolve('workspaces'), restartRequired: false, qqPaused: true, pathMappings: {} });
    const service = new BackupService(ctx, runtime, { dispose: async () => {} } as never);
    const server = createServer((req, res) => { void service.handle(req, res, '/backup/activate'); });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await service.dispose(); });
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(400);
    expect(activateConfiguration).toHaveBeenCalledTimes(1);
    expect(state.migration).toMatchObject({ qqPaused: true, activationPending: true });
    expect(service.status().canActivate).toBe(true);
  });
});
