import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import { scheduleDomain, type ScheduleTask } from '@deepseek-ai/dsh-schedule';
import { z } from 'zod';
import { PLUGIN_ROOT, PLUGIN_VERSION, PLUGIN_PACKAGE_NAME } from '../shared/utils.ts';
import { DEFAULT_IDENTITY } from './identity-defaults.ts';
import { getHistoryStore, historyGroupKey } from '../features/history-store.ts';
import type { MemeModule } from './memes.ts';
import type { ZetaRuntime } from './runtime.ts';
import { zetaSnapshotSchema } from './state.ts';
import { extractEncryptedArchive, writeEncryptedArchive, writeTarGzip, type ArchiveEntry } from './backup-archive.ts';
import { activateConfiguration, exportConfiguration, preflightConfiguration, restoreConfiguration, restoreCredentials, validateConfiguration, type PortableConfiguration } from './backup-config.ts';
import { exportSessions, mappedWorkspace, restoreSessions, validateSessionTransfer } from './backup-sessions.ts';

const LIMIT = 2 * 1024 * 1024 * 1024;
const DSH_VERSION = '0.2.1-rc.3';
const MATERIAL_KINDS = ['memes', 'speech', 'persona', 'images', 'deployments', 'websites', 'browser/screenshots', 'shared-materials'] as const;
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const jsonCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const portablePath = z.string().max(8192).refine(value => /^(?:[a-z]:[\\/]|[\\/])/i.test(value) && !/[\u0000-\u001f]/.test(value));
const preferencesSchema = z.object({
  overrides: z.record(z.string().regex(/^qqbot:[^:\s]+:(?:c2c|group):[^:\s]+$/), z.object({ provider: z.string().min(1).max(160), model: z.string().min(1).max(240) }).strict()).default({}),
  sessionIds: z.record(z.string().regex(/^qqbot:[^:\s]+:(?:c2c|group):[^:\s]+$/), z.string().min(1).max(512)).default({}),
  presets: z.record(z.string().regex(/^qqbot:[^:\s]+:(?:c2c|group):[^:\s]+$/), z.string().min(1).max(160)).default({}),
}).strict();
function readPreferences(value: unknown): z.infer<typeof preferencesSchema> { return preferencesSchema.parse(value); }
const manifestSchema = z.object({
  formatVersion: z.literal(1), id: z.string().uuid(), pluginVersion: z.string().max(80), dshVersion: z.literal(DSH_VERSION), createdAt: z.string().datetime(),
  includesCredentials: z.boolean(), state: zetaSnapshotSchema, configuration: z.unknown(), sessions: z.array(z.unknown()).max(10000), attachments: z.array(z.unknown()).max(20000),
  schedules: z.array(z.unknown()).max(10000), presets: z.array(z.object({ id: z.string().max(160), digest: z.string().length(64).optional(), content: z.string().max(2 * 1024 * 1024).optional(), missing: z.boolean().default(false) })).max(200),
  source: z.object({ dataDir: portablePath, mediaDir: portablePath, cwd: portablePath, previousMappings: z.record(portablePath, portablePath).default({}) }),
  groups: z.array(z.object({ appId: z.string(), peerId: z.string(), entries: z.array(z.object({ messageId: z.string(), senderId: z.string(), senderName: z.string().optional(), content: z.string(), timestamp: z.number() })).max(1000) })).max(10000),
  files: z.array(z.object({ name: z.string().max(4096), size: z.number().int().nonnegative(), sha256: z.string().length(64) })).max(20000), warnings: z.array(z.string()).max(1000),
}).strict();
type Manifest = z.infer<typeof manifestSchema>;
type NativeExport = Awaited<ReturnType<typeof exportSessions>>;
type NativePlan = Awaited<ReturnType<typeof validateSessionTransfer>>;
interface Stage { directory: string; root: string; manifest: Manifest; manifestDigest: string; config: PortableConfiguration; plan: NativePlan; token: string; createdAt: number; preview: BackupPreview }
export interface BackupPreview {
  formatVersion: number; pluginVersion: string; dshVersion: string; createdAt: string; sessions: number; memoryItems: number; conversations: number;
  files: number; bytes: number; includesCredentials: boolean; warnings: string[]; canRestore: boolean; conflicts: string[];
}
class BackupError extends Error {}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value));
}
async function input(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 16384) throw new BackupError('请求过大'); chunks.push(Buffer.from(chunk)); }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BackupError('请求格式无效');
  return value as Record<string, unknown>;
}
function password(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 1024) throw new BackupError('迁移密码须为8至1024个字符');
  return value;
}
function fromHeader(req: IncomingMessage): string {
  const encoded = req.headers['x-zeta-backup-password'];
  if (typeof encoded !== 'string' || encoded.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new BackupError('迁移密码格式无效');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new BackupError('迁移密码格式无效');
  return password(bytes.toString('utf8'));
}
async function digestFile(path: string): Promise<string> { const digest = createHash('sha256'); for await (const part of createReadStream(path)) digest.update(part); return digest.digest('hex'); }
async function walk(root: string, prefix = ''): Promise<Array<{ name: string; path: string; size: number }>> {
  const result: Array<{ name: string; path: string; size: number }> = [];
  for (const child of await readdir(root, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${child.name}` : child.name; const path = join(root, child.name);
    if (child.isSymbolicLink()) throw new BackupError('备份目录含链接，请先把素材保存为实际文件');
    if (child.isDirectory()) result.push(...await walk(path, name));
    else if (child.isFile()) result.push({ name, path, size: (await stat(path)).size });
    else throw new BackupError('备份目录含不支持的文件类型');
  }
  return result;
}
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }

/** Owner-only portability service. It never registers a model tool. */
export class BackupService {
  private readonly stages = new Map<string, Stage>();
  private readonly operations = new Set<AbortController>();
  private committing = false;
  private disposed = false;
  private activeRestore?: string;
  private busy = false;
  private readonly home = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'));
  private readonly tempRoot = join(this.home, '.zeta-portability');
  constructor(private readonly ctx: Context, private readonly runtime: ZetaRuntime, private readonly memes: MemeModule) {}

  status(): { restartRequired: boolean; canActivate: boolean; maintenance: boolean; pendingRestore: boolean } {
    const migration = this.runtime.state.migration;
    return { restartRequired: migration?.restartRequired === true && (this.runtime.dataDir !== migration.dataRoot || migration.pendingSchedules.length > 0),
      canActivate: migration?.status === 'complete' && migration.qqPaused && !migration.error && migration.pendingSchedules.length === 0,
      maintenance: this.runtime.maintenance, pendingRestore: migration?.status === 'restoring' || !!migration?.error };
  }
  private async temporary(): Promise<string> { await mkdir(this.tempRoot, { recursive: true, mode: 0o700 }); return mkdtemp(join(this.tempRoot, 'stage-')); }
  private async cleanup(path: string): Promise<void> {
    const absolute = resolve(path); const root = resolve(this.tempRoot); const rel = relative(root, absolute);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || !basename(absolute).startsWith('stage-')) throw new Error('Invalid backup cleanup boundary');
    await rm(absolute, { recursive: true, force: true });
  }
  private async snapshotFiles(source: string, destination: string, signal?: AbortSignal): Promise<void> {
    if (!await exists(source)) return;
    const root = await realpath(source);
    for (const file of await walk(root)) {
      signal?.throwIfAborted();
      const target = join(destination, ...file.name.split('/'));
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const before = await stat(file.path);
      if (await exists(target)) {
        if ((await lstat(target)).isSymbolicLink() || await digestFile(target) !== await digestFile(file.path)) throw new BackupError('目标素材与迁移包不同，拒绝覆盖');
      } else await copyFile(file.path, target);
      const after = await stat(file.path);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new BackupError('素材正在变化，请稍后重新导出');
    }
  }
  private async pluginEntries(): Promise<ArchiveEntry[]> {
    const root = await realpath(PLUGIN_ROOT); const entries: ArchiveEntry[] = [];
    for (const name of ['dist', 'lib', 'assets', 'locale', 'vendor', 'package.json', 'package-lock.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'scripts/install-local.ps1', 'scripts/inspect-local-runtime.cjs']) {
      const path = join(root, name); if (!await exists(path)) continue;
      const info = await lstat(path); if (info.isSymbolicLink()) throw new BackupError('插件分发目录含不支持的链接');
      const files = info.isDirectory() ? await walk(path, name) : [{ name, path, size: info.size }];
      for (const file of files) entries.push({ name: `package/${file.name}`, size: file.size, open: () => createReadStream(file.path) });
    }
    if (!entries.some(entry => entry.name === 'package/dist/index.js')) throw new BackupError('插件尚未构建，无法导出可安装代码');
    return entries;
  }
  private async exportBundle(pass: string, credentials: boolean, signal: AbortSignal): Promise<{ directory: string; path: string }> {
    const directory = await this.temporary(); const root = join(directory, 'payload'); await mkdir(root);
    try {
      await this.runtime.withMaintenance(async () => {
        await this.memes.dispose();
        const state = await this.runtime.state.snapshot();
        const qq = this.runtime.exportQQConfiguration();
        const prefsPath = join(this.home, 'zeta', 'qq-model-prefs.json');
        let prefs: Record<string, unknown> = {};
        if (await exists(prefsPath)) { prefs = readPreferences(JSON.parse(await readFile(prefsPath, 'utf8'))); await writeFile(join(root, 'qq-prefs.json'), JSON.stringify(prefs), { flag: 'wx', mode: 0o600 }); }
        const roots = new Set<string>(Object.values(state.tables.bindings).map(record => record.sessionId));
        for (const record of this.runtime.conversations()) if (record.sessionId) roots.add(record.sessionId);
        if (state.tables.life.main?.sessionId) roots.add(state.tables.life.main.sessionId);
        if (prefs.sessionIds && typeof prefs.sessionIds === 'object') for (const id of Object.values(prefs.sessionIds)) if (typeof id === 'string') roots.add(id);
        const transfer = await exportSessions(this.ctx, [...roots], root, signal);
        const providers: string[] = [];
        if (prefs.overrides && typeof prefs.overrides === 'object') for (const value of Object.values(prefs.overrides)) if (value && typeof value === 'object' && 'provider' in value && typeof value.provider === 'string') providers.push(value.provider);
        const configuration = await exportConfiguration(this.ctx, qq, credentials, signal, providers);
        const warnings = [...transfer.warnings, ...configuration.warnings];
        const selected = new Set(transfer.sessions.map(record => record.id));
        const schedules: ScheduleTask[] = [];
        for (const item of await this.ctx.schedule.catalog()) if (selected.has(item.sessionId)) {
          const { sessionId, status, lastDelivery, ...record } = item;
          const records: unknown[] = []; let before: string | undefined; let earlierRecordsUnavailable = false; let earlierRecordsPruned = false;
          do {
            const page = await this.ctx.schedule.history({ sessionId, id: record.id, limit: 100, ...(before ? { before: before as never } : {}) });
            if ('code' in page) throw new BackupError('自动任务记录变化，请稍后重试');
            records.push(...page.records); earlierRecordsUnavailable ||= page.earlierRecordsUnavailable; earlierRecordsPruned ||= page.earlierRecordsPruned;
            before = page.nextBefore;
          } while (before);
          schedules.push(scheduleDomain.tables.tasks.valueSchema.parse(jsonCopy({ sessionId, record, status, ...(lastDelivery ? { lastDelivery } : {}), deliveryHistory: { records: records.toReversed(), earlierRecordsUnavailable, earlierRecordsPruned } })));
        }
        const presets: Manifest['presets'] = [];
        const presetIds = new Set(transfer.sessions.map(row => row.header.agentPreset).filter((id): id is string => !!id));
        if (typeof qq.preset === 'string' && qq.preset) presetIds.add(qq.preset);
        if (prefs.presets && typeof prefs.presets === 'object') for (const id of Object.values(prefs.presets)) if (typeof id === 'string') presetIds.add(id);
        for (const id of presetIds) {
          try { const document = await this.ctx.agentPresets.readDocument(id); presets.push({ id, digest: hash(document.content), missing: false, ...(credentials ? { content: document.content } : {}) }); }
          catch { presets.push({ id, missing: true }); warnings.push(`源电脑未保留Agent预设${id}的声明，目标电脑需安装同名预设`); }
        }
        const groups: Manifest['groups'] = [];
        for (const record of this.runtime.state.conversations()) if (record.scope === 'group') {
          const entries = await getHistoryStore().list(historyGroupKey(record.appId, record.peerId), 1000);
          if (entries.length) groups.push(jsonCopy({ appId: record.appId, peerId: record.peerId, entries }));
        }
        for (const kind of MATERIAL_KINDS) await this.snapshotFiles(join(this.runtime.dataDir, kind), join(root, 'data', kind), signal);
        await this.snapshotFiles(join(this.home, 'zeta', 'qq-media'), join(root, 'qq-media'), signal);
        for (const entry of await this.pluginEntries()) {
          const destination = join(root, 'plugin', ...entry.name.split('/')); await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
          await pipeline(entry.open(), createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal });
        }
        const files: Manifest['files'] = []; let total = 0;
        for (const file of await walk(root)) { signal.throwIfAborted(); total += file.size; if (total > LIMIT) throw new BackupError('迁移数据超过2GiB上限，本次未生成不完整备份'); files.push({ name: file.name, size: file.size, sha256: await digestFile(file.path) }); }
        const manifest: Manifest = manifestSchema.parse(jsonCopy({ formatVersion: 1, id: randomUUID(), pluginVersion: PLUGIN_VERSION, dshVersion: DSH_VERSION, createdAt: new Date().toISOString(), includesCredentials: credentials, state, configuration, sessions: transfer.sessions, attachments: transfer.attachments, schedules, presets, groups, files, warnings,
          source: { dataDir: this.runtime.dataDir, mediaDir: join(this.home, 'zeta', 'qq-media'), cwd: typeof qq.cwd === 'string' && qq.cwd ? qq.cwd : process.cwd(), previousMappings: this.runtime.state.migration?.pathMappings ?? {} } }));
        await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
      });
      const files = await walk(root);
      const entries = files.map(file => ({ name: file.name, size: file.size, open: () => createReadStream(file.path) }));
      const path = join(directory, 'backup.zeta-backup'); await writeEncryptedArchive(entries, path, pass, signal);
      return { directory, path };
    } catch (error) { await this.cleanup(directory); throw error; }
  }
  private async freshConflicts(backupId: string, backupDigest: string): Promise<string[]> {
    const state = this.runtime.state; const migration = state.migration;
    if (migration?.backupId === backupId && migration.backupDigest === backupDigest && (migration.status === 'restoring' || (migration.restartRequired && this.runtime.dataDir !== migration.dataRoot))) return [];
    const snapshot = await state.snapshot(); const conflicts: string[] = [];
    const identity = snapshot.tables.identity.main;
    if (identity && (identity.revision > 0 || identity.history.length || JSON.stringify(identity.current) !== JSON.stringify(DEFAULT_IDENTITY))) conflicts.push('目标插件已有自定义身份或调整记录，请使用空插件环境迁移');
    if (Object.keys(snapshot.tables.bindings).length || Object.keys(snapshot.tables.conversations).length || Object.keys(snapshot.tables.users).length || Object.keys(snapshot.tables.effects).length || Object.values(snapshot.tables.memories).some(space => space.entries.length) || snapshot.tables.life.main?.sessionId) conflicts.push('目标插件已有聊天、用户目录、记忆或活动数据；请使用新电脑的空插件环境，避免覆盖');
    const prefs = join(this.home, 'zeta', 'qq-model-prefs.json');
    if (await exists(prefs)) { const value = readPreferences(JSON.parse(await readFile(prefs, 'utf8'))); if (Object.keys(value.sessionIds).length || Object.keys(value.overrides).length || Object.keys(value.presets).length) conflicts.push('目标已有QQ会话偏好，请使用空插件环境迁移'); }
    for (const kind of MATERIAL_KINDS.filter(value => value !== 'shared-materials')) {
      const root = join(this.runtime.dataDir, kind); if (!await exists(root)) continue;
      if ((await walk(root)).some(file => ['persona', 'images', 'deployments', 'websites'].includes(kind) ? !['usage.json'].includes(file.name) : /\.(?:wav|mp3|png|jpe?g|webp|gif)$/i.test(file.name))) conflicts.push('目标插件已有语音或表情原件，无法直接覆盖恢复');
    }
    return conflicts;
  }
  private async preview(req: IncomingMessage, pass: string, signal: AbortSignal): Promise<Stage> {
    for (const [token, stage] of this.stages) if (Date.now() - stage.createdAt > 30 * 60000) { this.stages.delete(token); await this.cleanup(stage.directory); }
    // Changing the file/password or revisiting the page loses its old token.
    // Keep only a few previews and retire the oldest unused staging directory.
    while (this.stages.size >= 3) {
      const oldest = [...this.stages].find(([token]) => token !== this.activeRestore);
      if (!oldest) throw new BackupError('正在恢复数据，请等待完成后重新校验');
      this.stages.delete(oldest[0]); await this.cleanup(oldest[1].directory);
    }
    const directory = await this.temporary(); const archive = join(directory, 'upload.zeta-backup'); const root = join(directory, 'payload'); await mkdir(root);
    try {
      let uploaded = 0;
      await pipeline(req, new Transform({ transform(chunk: Buffer, _encoding, callback) { uploaded += chunk.length; callback(uploaded > LIMIT ? new BackupError('迁移包超过2GiB') : null, chunk); } }), createWriteStream(archive, { flags: 'wx', mode: 0o600 }), { signal });
      const extracted = await extractEncryptedArchive(archive, root, pass, signal);
      const manifestFile = extracted.files.find(file => file.name === 'manifest.json');
      if (!manifestFile || manifestFile.size > 64 * 1024 * 1024) throw new BackupError('迁移包缺少有效清单');
      const manifestBytes = await readFile(manifestFile.path); const manifestDigest = hash(manifestBytes);
      const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
      const actual = new Map(extracted.files.filter(file => file.name !== 'manifest.json').map(file => [file.name, file]));
      if (actual.size !== manifest.files.length) throw new BackupError('迁移包文件清单不一致');
      for (const file of manifest.files) {
        const found = actual.get(file.name);
        if (!found || found.size !== file.size || found.sha256 !== file.sha256 || !/^(?:plugin\/package\/|data\/(?:memes|speech|persona|images|deployments|websites|browser\/screenshots|shared-materials)\/|qq-media\/|sessions\/|attachments\/|qq-prefs\.json$)/.test(file.name)) throw new BackupError('迁移包校验失败，未修改本机数据');
        actual.delete(file.name);
      }
      if (actual.size) throw new BackupError('迁移包包含重复或未声明文件');
      const config = validateConfiguration(manifest.configuration, this.ctx);
      if (config.includesCredentials !== manifest.includesCredentials) throw new BackupError('迁移包凭据清单不一致');
      const conflicts = await this.freshConflicts(manifest.id, manifestDigest); const warnings = [...manifest.warnings];
      try { await preflightConfiguration(this.ctx, config, signal); }
      catch { conflicts.push('目标的模型配置、QQ入口或连接凭据存在冲突，请先在DSH设置中处理后重新校验'); }
      if (![PLUGIN_VERSION, '0.4.2', '0.4.1', '0.4.0', '0.3.0'].includes(manifest.pluginVersion)) conflicts.push(`迁移包使用插件${manifest.pluginVersion}，请先安装同版本插件后恢复`);
      for (const preset of manifest.presets) {
        try { if (preset.digest && hash((await this.ctx.agentPresets.readDocument(preset.id)).content) !== preset.digest) conflicts.push(`Agent预设${preset.id}与源电脑不同，请先安装相同预设及所需DSH插件`); else if (preset.missing) warnings.push(`源电脑缺少预设${preset.id}声明，将使用目标电脑已安装的同名预设`); }
        catch { conflicts.push(`目标电脑缺少Agent预设${preset.id}，请先安装对应DSH插件和预设`); }
      }
      const workspaceRoot = join(homedir(), 'ProjectZeta-Migrated', manifest.id, 'workspaces');
      const previous = this.runtime.state.migration;
      const resume = previous?.backupId === manifest.id && previous.backupDigest === manifestDigest && (previous.status === 'restoring' || (previous.restartRequired && this.runtime.dataDir !== previous.dataRoot));
      const plan = await validateSessionTransfer(this.ctx, root, manifest.sessions as NativeExport['sessions'], manifest.attachments as NativeExport['attachments'], workspaceRoot, signal, { resume });
      conflicts.push(...plan.conflicts); warnings.push(...plan.warnings);
      const ids = new Set((manifest.sessions as NativeExport['sessions']).map(row => row.id));
      const references = new Set(Object.values(manifest.state.tables.bindings).map(value => value.sessionId));
      for (const record of Object.values(manifest.state.tables.conversations)) if (record.sessionId) references.add(record.sessionId);
      if (manifest.state.tables.life.main?.sessionId) references.add(manifest.state.tables.life.main.sessionId);
      if (await exists(join(root, 'qq-prefs.json'))) {
        const prefs = readPreferences(JSON.parse(await readFile(join(root, 'qq-prefs.json'), 'utf8')));
        for (const id of Object.values(prefs.sessionIds)) references.add(id);
      }
      for (const id of references) if (!ids.has(id) && await this.ctx.sessionPersistence.stat(id as never, { signal })) conflicts.push('备份绑定指向目标电脑已有的非迁移会话，拒绝覆盖或借用');
      for (const raw of manifest.schedules) {
        const task = scheduleDomain.tables.tasks.valueSchema.parse(raw);
        if (!ids.has(task.sessionId)) throw new BackupError('自动任务不属于迁移会话');
        if ((await this.ctx.schedule.catalog()).some(value => value.id === task.record.id) && this.runtime.state.migration?.backupId !== manifest.id) conflicts.push('目标已有相同自动任务标识，拒绝覆盖');
      }
      warnings.push('恢复后QQ连接与自主生活先暂停；工作目录会在用户目录ProjectZeta-Migrated下重新建立，外部工作目录文件不自动打包。');
      const preview: BackupPreview = { formatVersion: 1, pluginVersion: manifest.pluginVersion, dshVersion: manifest.dshVersion, createdAt: manifest.createdAt, sessions: manifest.sessions.length,
        memoryItems: Object.values(manifest.state.tables.memories).reduce((sum, value) => sum + value.entries.length, 0), conversations: Object.keys(manifest.state.tables.conversations).length,
        files: manifest.files.length, bytes: extracted.bytes, includesCredentials: manifest.includesCredentials, warnings: [...new Set(warnings)], conflicts: [...new Set(conflicts)], canRestore: conflicts.length === 0 };
      const token = randomUUID(); const stage = { directory, root, manifest, manifestDigest, config, plan, token, createdAt: Date.now(), preview }; this.stages.set(token, stage); return stage;
    } catch (error) { await this.cleanup(directory); throw error; }
  }
  private async restore(stage: Stage): Promise<{ restored: true; restartRequired: true; sessions: number; files: number; warnings: string[] }> {
    if (!stage.preview.canRestore || Date.now() - stage.createdAt > 30 * 60000) throw new BackupError('预览已过期或有冲突，请重新校验迁移包');
    const conflicts = await this.freshConflicts(stage.manifest.id, stage.manifestDigest); if (conflicts.length) throw new BackupError(conflicts[0]);
    const { manifest } = stage; const signal = new AbortController().signal;
    const dataRoot = join(this.home, 'zeta-restored', manifest.id); const workspaceRoot = join(homedir(), 'ProjectZeta-Migrated', manifest.id, 'workspaces');
    const previous = this.runtime.state.migration; const resume = previous?.backupId === manifest.id && previous.backupDigest === stage.manifestDigest;
    if (await exists(dataRoot) && !resume) throw new BackupError('迁移目标目录已存在，拒绝覆盖');
    this.activeRestore = stage.token;
    return this.runtime.withMaintenance(async () => {
      // Recheck after every in-flight writer has drained. Preview and the early
      // admission check cannot prevent a write completing before maintenance.
      const settledConflicts = await this.freshConflicts(stage.manifest.id, stage.manifestDigest);
      if (settledConflicts.length) throw new BackupError(settledConflicts[0]);
      await this.memes.dispose();
      await preflightConfiguration(this.ctx, stage.config, signal);
      for (const file of manifest.files) {
        const path = join(stage.root, ...file.name.split('/')); const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size || await digestFile(path) !== file.sha256) throw new BackupError('预览后的文件发生变化，请重新上传校验');
      }
      const snapshot = zetaSnapshotSchema.parse(jsonCopy(manifest.state));
      snapshot.tables.settings.main!.life.enabled = false; snapshot.tables.settings.main!.life.allowContact = false;
      snapshot.tables.life.main!.status = 'disabled'; delete snapshot.tables.life.main!.nextWakeAt; delete snapshot.tables.life.main!.runId; snapshot.tables.life.main!.planningInitialized = false; snapshot.tables.life.main!.planRevision++; snapshot.tables.settings.main!.browser.enabled = false; snapshot.tables.settings.main!.images.enabled = false; snapshot.tables.settings.main!.deployments.enabled = false; delete snapshot.tables.life.main!.error;
      const pathMappings: Record<string, string> = { [manifest.source.dataDir]: dataRoot, [manifest.source.mediaDir]: join(this.home, 'zeta', 'qq-media') };
      for (const row of manifest.sessions as NativeExport['sessions']) if (row.header.cwd) pathMappings[row.header.cwd] = mappedWorkspace(workspaceRoot, row.header.cwd);
      for (const [old, middle] of Object.entries(manifest.source.previousMappings)) {
        const normalized = middle.replaceAll('\\', '/');
        const match = Object.entries(pathMappings).toSorted((a, b) => b[0].length - a[0].length).find(([source]) => normalized === source.replaceAll('\\', '/') || normalized.startsWith(`${source.replaceAll('\\', '/')}/`));
        if (match) pathMappings[old] = join(match[1], ...normalized.slice(match[0].replaceAll('\\', '/').length).split('/').filter(Boolean));
      }
      await this.runtime.state.setMigration({ backupId: manifest.id, backupDigest: stage.manifestDigest, status: 'restoring', dataRoot, workspaceRoot, restartRequired: true, qqPaused: true, pathMappings, pendingSchedules: [], groupBuffers: [] });
      await restoreCredentials(this.ctx, stage.config, signal);
      await restoreSessions(this.ctx, stage.plan, signal, { resume });
      await mkdir(dataRoot, { recursive: true, mode: 0o700 });
      for (const kind of MATERIAL_KINDS) await this.snapshotFiles(join(stage.root, 'data', kind), join(dataRoot, kind));
      await this.snapshotFiles(join(stage.root, 'qq-media'), join(this.home, 'zeta', 'qq-media'));
      if (await exists(join(stage.root, 'qq-prefs.json'))) { await mkdir(join(this.home, 'zeta'), { recursive: true }); await copyFile(join(stage.root, 'qq-prefs.json'), join(this.home, 'zeta', 'qq-model-prefs.json')); }
      await this.runtime.state.restoreSnapshot(snapshot);
      for (const group of manifest.groups) for (const entry of group.entries) await getHistoryStore().append(historyGroupKey(group.appId, group.peerId), entry, Math.max(1, group.entries.length));
      const schedules = manifest.schedules.map(value => ({ ...scheduleDomain.tables.tasks.valueSchema.parse(value), status: 'inactive' }));
      await this.runtime.state.setMigration({ backupId: manifest.id, backupDigest: stage.manifestDigest, status: 'complete', dataRoot, workspaceRoot, restartRequired: true, qqPaused: true, pathMappings, pendingSchedules: jsonCopy(schedules), groupBuffers: jsonCopy(manifest.groups) });
      // The last operation may unload this instance through normal Loader rules.
      this.committing = true;
      const warnings = [...stage.preview.warnings, ...await restoreConfiguration(this.ctx, stage.config, { dataDir: dataRoot, cwd: mappedWorkspace(workspaceRoot, manifest.source.cwd), connectQQ: false })];
      return { restored: true, restartRequired: true, sessions: manifest.sessions.length, files: manifest.files.length, warnings: [...new Set(warnings)] };
    }, true);
  }
  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const controller = new AbortController(); this.operations.add(controller);
    let ownsOperation = false;
    req.once('aborted', () => controller.abort()); res.once('close', () => { if (!res.writableEnded && !this.activeRestore) controller.abort(); });
    try {
      if (this.disposed) throw new BackupError('插件已重新加载，请刷新页面');
      if (path === '/backup/status' && req.method === 'GET') { json(res, 200, this.status()); return; }
      if (req.method === 'POST') {
        if (this.busy) throw new BackupError('已有备份操作正在执行，请等待完成');
        this.busy = true; ownsOperation = true;
      }
      if (path === '/backup/plugin' && req.method === 'GET') {
        const directory = await this.temporary(); const file = join(directory, `${PLUGIN_PACKAGE_NAME}-${PLUGIN_VERSION}.tgz`);
        try { await writeTarGzip(await this.pluginEntries(), file, controller.signal); await this.download(res, file, `${PLUGIN_PACKAGE_NAME}-${PLUGIN_VERSION}.tgz`, controller.signal); }
        finally { await this.cleanup(directory); }
        return;
      }
      if (path === '/backup/export' && req.method === 'POST') {
        this.runtime.requireWritable();
        const data = await input(req); const bundle = await this.exportBundle(password(data.password), data.includeCredentials !== false, controller.signal);
        try { await this.download(res, bundle.path, `${PLUGIN_PACKAGE_NAME}-${new Date().toISOString().slice(0, 10)}.zeta-backup`, controller.signal); }
        finally { await this.cleanup(bundle.directory); }
        return;
      }
      if (path === '/backup/preview' && req.method === 'POST') { const stage = await this.preview(req, fromHeader(req), controller.signal); json(res, 200, { token: stage.token, preview: stage.preview }); return; }
      if (path === '/backup/restore' && req.method === 'POST') {
        const data = await input(req); const stage = typeof data.token === 'string' ? this.stages.get(data.token) : undefined;
        if (!stage) throw new BackupError('恢复预览已失效，请重新上传校验');
        const result = await this.restore(stage); this.stages.delete(stage.token); await this.cleanup(stage.directory); this.activeRestore = undefined;
        json(res, 200, result); return;
      }
      if (path === '/backup/activate' && req.method === 'POST') {
        if (!this.status().canActivate || this.runtime.dataDir !== this.runtime.state.migration?.dataRoot) throw new BackupError('请先重启DSH完成迁移，再启用QQ连接');
        const migration = this.runtime.state.migration!; await this.runtime.state.setMigration({ ...migration, activationPending: true, restartRequired: true });
        this.committing = true; await activateConfiguration(this.ctx); json(res, 200, { restartRequired: true }); return;
      }
      json(res, 404, { error: '备份操作不存在' });
    } catch (error) {
      if (ownsOperation) { this.committing = false; this.activeRestore = undefined; }
      if (!res.headersSent) json(res, 400, { error: error instanceof BackupError ? error.message : controller.signal.aborted ? '操作已取消' : '备份或恢复失败，请核对密码、文件完整性、插件版本和目标环境；源数据不会被覆盖' });
      else res.destroy();
    } finally { if (ownsOperation) this.busy = false; this.operations.delete(controller); }
  }
  private async download(res: ServerResponse, path: string, name: string, signal: AbortSignal): Promise<void> {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String((await stat(path)).size), 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    await pipeline(createReadStream(path), res, { signal });
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    if (!this.committing) for (const operation of this.operations) operation.abort();
    for (const stage of this.stages.values()) if (stage.token !== this.activeRestore) await this.cleanup(stage.directory);
    this.stages.clear();
  }
}
