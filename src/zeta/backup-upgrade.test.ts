import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZetaState } from './state.ts';
import { ZetaRuntime } from './runtime.ts';
import { testDomainContext } from './test-support.ts';
import { BackupService } from './backup.ts';
import { writeEncryptedArchive } from './backup-archive.ts';
import { restoreSessions } from './backup-sessions.ts';
import { PLUGIN_VERSION } from '../shared/utils.ts';

vi.mock('./backup-config.ts', async original => ({
  ...await original<typeof import('./backup-config.ts')>(),
  preflightConfiguration: vi.fn(async () => {}),
  restoreCredentials: vi.fn(async () => {}),
  restoreConfiguration: vi.fn(async () => []),
}));
vi.mock('./backup-sessions.ts', async original => ({
  ...await original<typeof import('./backup-sessions.ts')>(),
  validateSessionTransfer: vi.fn(async () => ({ conflicts: [], warnings: [] })),
  restoreSessions: vi.fn(async () => {}),
}));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
interface TestStage { manifest: any; preview: { canRestore: boolean; conflicts: string[] }; [key: string]: unknown }
interface PrivateBackup {
  preview(request: IncomingMessage, password: string, signal: AbortSignal): Promise<TestStage>;
  restore(stage: TestStage): Promise<unknown>;
}
async function fixture(version: string, inputs: Record<string, Buffer>) {
  const base = await realpath(tmpdir()), directory = await mkdtemp(join(base, 'zeta-upgrade-backup-'));
  cleanups.push(async () => {
    const rel = relative(base, directory);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Unsafe fixture cleanup');
    await rm(directory, { recursive: true, force: true });
  });
  vi.stubEnv('DSH_HOME', join(directory, 'home'));
  const ctx = Object.assign(testDomainContext(), {
    agents: { get: () => undefined }, llm: { listConfigurableProviders: () => [] },
    sessionPersistence: { stat: async () => undefined }, schedule: { catalog: async () => [] },
  }) as unknown as Context;
  const state = await ZetaState.open(ctx); cleanups.push(() => state.close());
  const runtime = new ZetaRuntime(ctx, state, 'bot', join(directory, 'empty-data'));
  const service = new BackupService(ctx, runtime, { dispose: async () => {} } as never); cleanups.push(() => service.dispose());
  const sourceState = await ZetaState.open(testDomainContext());
  await sourceState.updateIdentity({ expected_revision: sourceState.identity.revision, reason: '备份前自主调整', name: '迁移的人设', habits: ['随备份保留的真实习惯'] }, { sourceSessionId: 'source-identity-agent' });
  await sourceState.observeUser({ appId: 'bot', senderId: 'known-group-user', name: '实际群友', scope: 'group', peerId: 'group-source', seenAt: 123 });
  await sourceState.observeUser({ appId: 'different-bot', senderId: 'known-other-user', scope: 'c2c', peerId: 'known-other-user', seenAt: 456 });
  const expectedIdentity = sourceState.identity;
  const expectedUsers = sourceState.users();
  const snapshot: any = await sourceState.snapshot();
  await sourceState.close();
  snapshot.tables.settings.main.life.enabled = true;
  snapshot.tables.settings.main.life.allowContact = true;
  snapshot.tables.settings.main.browser.enabled = true;
  snapshot.tables.settings.main.images.enabled = true;
  snapshot.tables.settings.main.deployments.enabled = true;
  snapshot.tables.life.main.summary = '保留真实进展';
  if (['0.3.0', '0.4.0', '0.4.1'].includes(version)) delete snapshot.tables.users;
  if (version === '0.4.2') {
    const entry = { key: '旧记忆同名', value: '来自私聊的事实', tags: ['原标签'], pinned: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', sourceSessionId: 'original-memory-source' };
    snapshot.tables.memories = { 'qq:bot:c2c:legacy': { revision: 7, entries: [entry] }, 'qq:bot:group:legacy': { revision: 4, entries: [{ ...entry, value: '来自群聊的另一事实' }] } };
  }
  if (version === '0.3.0' || version === '0.4.0') {
    delete snapshot.tables.identity;
    delete snapshot.tables.settings.main.habits;
  }
  if (version === '0.3.0') {
    for (const key of ['security', 'group', 'browser', 'images', 'deployments']) delete snapshot.tables.settings.main[key];
    for (const key of ['minIntervalMinutes', 'maxDailyRuns']) delete snapshot.tables.settings.main.life[key];
    for (const key of ['nextWakeAt', 'nextWakeReason', 'planRevision', 'runId', 'claimedRunId', 'runDay', 'runCount', 'planningInitialized']) delete snapshot.tables.life.main[key];
  } else {
    snapshot.tables.settings.main.security.administrators = ['trusted-owner-id'];
    Object.assign(snapshot.tables.life.main, { nextWakeAt: Date.now() + 3600000, nextWakeReason: '之前的计划', runId: randomUUID(), planRevision: 7, planningInitialized: true });
  }
  const entries = [];
  for (const [name, bytes] of Object.entries(inputs)) {
    const path = join(directory, 'source', ...name.split('/')); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes);
    entries.push({ name, size: bytes.length, sha256: digest(bytes), path });
  }
  const manifest = {
    formatVersion: 1, id: randomUUID(), pluginVersion: version, dshVersion: '0.2.1-rc.3', createdAt: new Date().toISOString(),
    includesCredentials: false, state: snapshot,
    configuration: { qq: {}, models: [], references: [], records: [], includesCredentials: false, warnings: [] },
    sessions: [], attachments: [], schedules: [], presets: [], groups: [], warnings: [],
    source: { dataDir: join(directory, 'old-data'), mediaDir: join(directory, 'old-media'), cwd: join(directory, 'old-work') },
    files: entries.map(({ path: _path, ...entry }) => entry),
  };
  const manifestFile = join(directory, 'manifest.json'), manifestBytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(manifestFile, manifestBytes);
  const archive = join(directory, 'legacy.zeta-backup');
  await writeEncryptedArchive([
    { name: 'manifest.json', size: manifestBytes.length, open: () => createReadStream(manifestFile) },
    ...entries.map(entry => ({ name: entry.name, size: entry.size, open: () => createReadStream(entry.path) })),
  ], archive, 'upgrade-test-password', new AbortController().signal);
  const privateService = service as unknown as PrivateBackup;
  const preview = () => privateService.preview(createReadStream(archive) as unknown as IncomingMessage, 'upgrade-test-password', new AbortController().signal);
  return { directory, state, privateService, preview, expectedIdentity, expectedUsers };
}
describe('0.4 backup upgrade and new material boundaries', () => {
  it.each(['0.3.0', '0.4.0', '0.4.1', '0.4.2', '0.4.3', '0.4.4', '0.4.5', '0.4.6', '0.4.7'])('previews and restores an encrypted %s archive with additive defaults and no automatic external activity', async version => {
    const files = { 'data/memes/old-library/image.gif': Buffer.from('legacy exact gif bytes') };
    const f = await fixture(version, files), stage = await f.preview();
    expect(stage.preview.canRestore).toBe(true);
    expect(stage.manifest.state.tables.settings.main.images).toMatchObject({ enabled: version !== '0.3.0', model: 'gemini-nano-banana-2.1-ext', resolution: '1K' });
    expect(stage.manifest.state.tables.life.main.planRevision).toBe(version === '0.3.0' ? 0 : 7);
    await f.privateService.restore(stage);
    expect(f.state.settings.name).toBe('迁移的人设'); expect(f.state.life.summary).toBe('保留真实进展');
    expect(f.state.settings.life.enabled).toBe(false); expect(f.state.settings.life.allowContact).toBe(false);
    expect(f.state.settings.browser.enabled).toBe(false); expect(f.state.settings.images.enabled).toBe(false); expect(f.state.settings.deployments.enabled).toBe(false);
    expect(f.state.settings.security.administrators).toEqual(version === '0.3.0' ? [] : ['trusted-owner-id']);
    expect(f.state.users()).toEqual(['0.3.0', '0.4.0', '0.4.1'].includes(version) ? [] : f.expectedUsers);
    if (version === '0.4.2') {
      const memories = f.state.listMemory('any-legacy-space');
      expect(memories.map(entry => entry.value).sort()).toEqual(['来自私聊的事实', '来自群聊的另一事实'].sort());
      expect(memories.every(entry => entry.sourceSessionId === 'original-memory-source' && entry.pinned && entry.createdAt === '2026-01-01T00:00:00.000Z')).toBe(true);
      expect(f.state.spaces()).toHaveLength(1);
    }
    expect(f.state.life.nextWakeAt).toBeUndefined(); expect(f.state.life.planningInitialized).toBe(false);
    expect(await readFile(join(f.state.migration!.dataRoot, 'memes', 'old-library', 'image.gif'))).toEqual(files['data/memes/old-library/image.gif']);
    expect(restoreSessions).toHaveBeenCalledTimes(1);
  });

  it('preserves persona, generated image records, website artifacts and screenshots while pausing new services', async () => {
    const files = {
      'data/persona/reference.json': Buffer.from('{"id":"persona-record"}'),
      'data/persona/persona.png': Buffer.from('persona exact bytes'),
      'data/images/owner/task.json': Buffer.from('{"status":"completed","taskId":"original-task"}'),
      'data/images/owner/task.png': Buffer.from('generated exact bytes'),
      'data/websites/preview/build/index.html': Buffer.from('<h1>Original preview</h1>'),
      'data/deployments/preview.json': Buffer.from('{"status":"expired","id":"original-preview"}'),
      'data/shared-materials/migration.json': Buffer.from('{"version":1,"copied":["original-path"]}'),
      'data/browser/screenshots/owner/screen.png': Buffer.from('screenshot exact bytes'),
    };
    const f = await fixture(PLUGIN_VERSION, files), stage = await f.preview(); expect(stage.preview.canRestore).toBe(true);
    await f.privateService.restore(stage);
    for (const [name, expected] of Object.entries(files)) expect(await readFile(join(f.state.migration!.dataRoot, ...name.slice(5).split('/')))).toEqual(expected);
    expect(f.state.settings.security.administrators).toEqual(['trusted-owner-id']);
    expect(f.state.identity).toEqual(f.expectedIdentity);
    expect(f.state.users()).toEqual(f.expectedUsers);
    expect(f.state.identity.history.at(-1)).toMatchObject({ reason: '备份前自主调整', sourceSessionId: 'source-identity-agent' });
    expect(f.state.life.planRevision).toBe(8); expect(f.state.life.runId).toBeUndefined();
    expect(f.state.settings.browser.enabled || f.state.settings.images.enabled || f.state.settings.deployments.enabled).toBe(false);
    expect(f.state.migration).toMatchObject({ qqPaused: true, restartRequired: true });
  });

  it('rejects a manifest that attempts to restore live browser lease state', async () => {
    const f = await fixture(PLUGIN_VERSION, { 'data/browser/usage.json': Buffer.from('{"orphans":[{"remote":"live-session"}]}') });
    await expect(f.preview()).rejects.toThrow('迁移包校验失败');
    expect(restoreSessions).not.toHaveBeenCalled(); expect(f.state.migration).toBeUndefined();
  });

  it('restores shared QQ model/preset preferences together with untouched legacy choices and per-chat history ids', async () => {
    const preferences = { overrides: { 'qqbot:bot:shared': { provider: 'shared-provider', model: 'shared-model' }, 'qqbot:bot:c2c:alice': { provider: 'legacy-provider', model: 'legacy-model' } },
      presets: { 'qqbot:bot:shared': 'shared-preset', 'qqbot:bot:group:room': 'legacy-preset' }, sessionIds: { 'qqbot:bot:c2c:alice': 'original-history-id' } };
    const f = await fixture(PLUGIN_VERSION, { 'qq-prefs.json': Buffer.from(JSON.stringify(preferences)) }), stage = await f.preview();
    expect(stage.preview.canRestore).toBe(true); await f.privateService.restore(stage);
    expect(JSON.parse(await readFile(join(process.env.DSH_HOME!, 'zeta', 'qq-model-prefs.json'), 'utf8'))).toEqual(preferences);
  });

  it('refuses to overwrite a target with autonomous identity history even when it has no chats or media', async () => {
    const f = await fixture(PLUGIN_VERSION, {});
    await f.state.updateIdentity({ expected_revision: f.state.identity.revision, reason: '新机已经形成自己的名字', name: '目标已有的名字' });
    const stage = await f.preview();
    expect(stage.preview.canRestore).toBe(false); expect(stage.preview.conflicts.some(value => value.includes('自定义身份'))).toBe(true);
    expect(f.state.settings.name).toBe('目标已有的名字'); expect(restoreSessions).not.toHaveBeenCalled();
  });
});
