/** Shared QQ adapter for yyh-001/dsh-meme (MIT, see vendor/dsh-meme). */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { MemesStore, ensurePackAt, openIndexWriter, searchRows, type MemeRow } from '../../vendor/dsh-meme/memes.js';
import { safeArchiveName, unzipBounded, zipStore } from '../../vendor/dsh-meme/zip.js';
import type { ModuleExecution, ModuleHost } from './contracts.ts';
import { migrateLegacyMemeCollections } from './memes-migration.ts';
export { migrateLegacyMemeCollections } from './memes-migration.ts';

export interface MemeItem {
  id: string;
  caption: string;
  tag: string;
  keywords: string[];
  fileName: string;
  builtin: boolean;
}

export interface MemeMetadata {
  caption: string;
  tag?: string;
  keywords?: string[];
}

export interface MemeListOptions {
  query?: string;
  tag?: string;
  limit?: number;
  offset?: number;
}

export interface MemeModuleOptions {
  builtinRoot?: string;
  maxImageBytes?: number;
  maxCollectionItems?: number;
  /** Trusted input paths recorded by the QQ adapter, never model-selected roots. */
  allowedInputFiles?: (agent: unknown) => readonly string[] | Promise<readonly string[]>;
}

export interface MemeZipImportResult {
  imported: number;
  items: MemeItem[];
  skipped: number;
  complete: boolean;
  cancelled?: boolean;
  error?: string;
}

interface LocatedMeme extends MemeItem {
  root: string;
  path: string;
}

const DEFAULT_BUILTIN_ROOT = fileURLToPath(new URL('../../vendor/dsh-meme/memes/dafeiyu-001/', import.meta.url));
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const ID_RE = /^(builtin|collection):([A-Za-z0-9_-]+)$/;
const MAX_LIMIT = 50;

function keywordList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 30 || value.some((term) => typeof term !== 'string')) {
    throw new Error('表情关键词应为最多 30 项的文字数组。');
  }
  return [...new Set(value.map((term: string) => term.trim()).filter(Boolean))].map((term) => {
    if (term.length > 80) throw new Error('单个表情关键词过长。');
    return term;
  });
}

function metadata(value: MemeMetadata): Required<MemeMetadata> {
  if (typeof value.caption !== 'string' || !value.caption.trim() || value.caption.length > 1000) {
    throw new Error('请提供 1–1000 字的表情描述；模型可根据已见图片提供描述。');
  }
  const tag = value.tag === undefined ? 'misc' : value.tag.trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,48}$/.test(tag)) throw new Error('表情分类应为 1–48 位英文、数字、下划线或短横线。');
  return { caption: value.caption.trim(), tag, keywords: keywordList(value.keywords) };
}

function checkedLimit(value: number | undefined, defaultValue = 12): number {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) throw new Error(`limit 应为 1–${MAX_LIMIT} 的整数。`);
  return value;
}

function inRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function imageExtension(bytes: Uint8Array): string {
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return '.jpg';
  const start = Buffer.from(bytes.subarray(0, 12)).toString('ascii');
  if (start.startsWith('GIF87a') || start.startsWith('GIF89a')) return '.gif';
  if (start.startsWith('RIFF') && start.slice(8, 12) === 'WEBP') return '.webp';
  throw new Error('仅支持真实 PNG、JPEG、GIF 或 WebP 图片。');
}

function itemId(builtin: boolean, path: string): string {
  return `${builtin ? 'builtin' : 'collection'}:${Buffer.from(path, 'utf8').toString('base64url')}`;
}

function toItem(row: MemeRow, root: string, builtin: boolean): LocatedMeme {
  return {
    id: itemId(builtin, row.path),
    caption: String(row.caption || row.file_name || ''),
    tag: String(row.tag || 'misc'),
    keywords: String(row.keywords || '').split(/[\s,，]+/u).filter(Boolean),
    fileName: basename(row.path),
    builtin,
    root,
    path: row.path,
  };
}

function publicItem(item: LocatedMeme): MemeItem {
  const { root: _root, path: _path, ...result } = item;
  return result;
}

/** Builtin packs are read-only; every trusted conversation uses one collection. */
export class MemeModule {
  private readonly builtinRoot: string;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly maxImageBytes: number;
  private readonly maxCollectionItems: number;
  private readonly migrations = new Map<string, Promise<unknown>>();

  constructor(private readonly host: ModuleHost, private readonly options: MemeModuleOptions = {}) {
    this.builtinRoot = resolve(options.builtinRoot || DEFAULT_BUILTIN_ROOT);
    this.maxImageBytes = options.maxImageBytes ?? MAX_IMAGE_BYTES;
    this.maxCollectionItems = options.maxCollectionItems ?? 500;
    // Fail loudly if an installation omitted its pack instead of claiming an empty library.
    new MemesStore(this.builtinRoot).close();
  }

  private assertAgent(agent: unknown): void {
    if (!this.host.bindingFor(agent) && !this.host.isLifeAgent(agent)) throw new Error('当前会话没有可信的 QQ 或自主生活绑定。');
  }

  private async collectionRoot(agent: unknown): Promise<string> {
    this.assertAgent(agent);
    const root = resolve(await this.host.directoryFor(agent, 'memes'));
    await mkdir(root, { recursive: true });
    ensurePackAt(root, { id: 'collection', name: '共享表情库', description: 'dsh-feiyu-zeta shared dsh-meme collection' });
    let migration = this.migrations.get(root);
    if (!migration) {
      this.host.requireWritable?.();
      migration = migrateLegacyMemeCollections(this.host.dataDir, root, this.maxImageBytes);
      this.migrations.set(root, migration);
    }
    try { await migration; } catch (error) { this.migrations.delete(root); throw error; }
    return root;
  }

  private async serialized<T>(root: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(root) ?? Promise.resolve();
    const running = previous.catch(() => undefined).then(() => { this.host.requireWritable?.(); return work(); });
    this.queues.set(root, running);
    try { return await running; }
    finally { if (this.queues.get(root) === running) this.queues.delete(root); }
  }

  private async locatedItems(agent: unknown, tag?: string): Promise<LocatedMeme[]> {
    const root = await this.collectionRoot(agent);
    const builtin = new MemesStore(this.builtinRoot);
    const collection = new MemesStore(root);
    try {
      return [
        ...collection.list(tag).memes.map((row) => toItem(row, root, false)),
        ...builtin.list(tag).memes.map((row) => toItem(row, this.builtinRoot, true)),
      ];
    } finally { builtin.close(); collection.close(); }
  }

  async list(agent: unknown, options: MemeListOptions = {}): Promise<{ items: MemeItem[]; total: number; hasMore: boolean }> {
    const limit = checkedLimit(options.limit);
    const offset = options.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw new Error('offset 无效。');
    if (options.query !== undefined && (typeof options.query !== 'string' || options.query.length > 240)) throw new Error('搜索词过长。');
    if (options.tag !== undefined && (typeof options.tag !== 'string' || options.tag.length > 48)) throw new Error('分类无效。');
    let items = await this.locatedItems(agent, options.tag);
    if (options.query?.trim()) {
      // Use upstream's Chinese substring/bigram ranking, with stable Zeta identity carried alongside it.
      const rows = items.map((item) => ({ ...item, file_name: item.fileName, keywords: item.keywords.join(' ') }));
      items = searchRows(rows, options.query, rows.length).memes.map((row) => ({ ...row, keywords: row.keywords.split(/\s+/u).filter(Boolean) }));
    }
    return { items: items.slice(offset, offset + limit).map(publicItem), total: items.length, hasMore: offset + limit < items.length };
  }

  private async locate(agent: unknown, id: string): Promise<LocatedMeme> {
    if (typeof id !== 'string' || id.length > 2048 || !ID_RE.test(id)) throw new Error('表情 ID 无效，请先调用 meme_list 或 send_meme 搜索。');
    const item = (await this.locatedItems(agent)).find((candidate) => candidate.id === id);
    if (!item) throw new Error('共享表情库中不存在此表情。');
    return item;
  }

  async fileFor(agent: unknown, id: string): Promise<string> {
    const item = await this.locate(agent, id);
    const root = await realpath(item.root);
    const path = await realpath(resolve(item.root, item.path));
    if (!inRoot(root, path)) throw new Error('图片实际路径超出图库。');
    const info = await stat(path);
    if (!info.isFile() || info.size > this.maxImageBytes) throw new Error('图片不可用或超出大小限制。');
    return path;
  }

  async send(agent: unknown, id: string, target: string | undefined, signal: AbortSignal): Promise<{ item: MemeItem; sent: true; receipt: Record<string, unknown> }> {
    signal.throwIfAborted();
    if (this.host.isLifeAgent(agent) && !target?.trim()) throw new Error('自主发表情必须指定联系目标。');
    const item = await this.locate(agent, id);
    const file = await this.fileFor(agent, id);
    signal.throwIfAborted();
    const receipt = await this.host.sendFile(agent, file, target, signal);
    return { item: publicItem(item), sent: true, receipt };
  }

  async importImage(agent: unknown, bytes: Uint8Array, fileName: string, meta: MemeMetadata, signal?: AbortSignal): Promise<MemeItem> {
    signal?.throwIfAborted();
    if (bytes.byteLength === 0 || bytes.byteLength > this.maxImageBytes) throw new Error(`图片大小应为 1–${this.maxImageBytes} 字节。`);
    const ext = imageExtension(bytes);
    if (!IMAGE_EXTENSIONS.has(extname(fileName).toLowerCase())) throw new Error('文件扩展名不是支持的图片。');
    const details = metadata(meta);
    const root = await this.collectionRoot(agent);
    return this.serialized(root, async () => {
      signal?.throwIfAborted();
      const hash = createHash('sha256').update(bytes).digest('hex');
      const rel = `memes/${hash}${ext}`;
      const destination = resolve(root, rel);
      const actualRoot = await realpath(root);
      await mkdir(join(root, 'memes'), { recursive: true });
      const actualParent = await realpath(join(root, 'memes'));
      if (!inRoot(actualRoot, actualParent)) throw new Error('收藏目录超出当前会话范围。');
      const db = openIndexWriter(root);
      try {
        const existing = db.prepare('SELECT path FROM memes WHERE path = ?').get(rel);
        const count = db.prepare('SELECT COUNT(*) AS count FROM memes').get() as { count: number };
        if (!existing && count.count >= this.maxCollectionItems) throw new Error('共享表情库已满，请先从管理页删除部分图片；旧图库迁移不会丢弃超额收藏。');
        const temp = join(actualParent, `.${hash}-${randomUUID()}.tmp`);
        try {
          await writeFile(temp, bytes, { flag: 'wx' });
          signal?.throwIfAborted();
          await rename(temp, destination);
        } finally { await unlink(temp).catch(() => undefined); }
        db.prepare('INSERT OR REPLACE INTO memes (path, tag, file_name, caption, keywords, mtime, captioned_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(rel, details.tag, basename(fileName), details.caption, details.keywords.join(' '), Date.now(), Date.now());
      } finally { db.close(); }
      const store = new MemesStore(root);
      try {
        const row = store.rows.find((entry) => entry.path === rel);
        if (!row) throw new Error('图片索引写入后未找到，收藏未完成。');
        return publicItem(toItem(row, root, false));
      } finally { store.close(); }
    });
  }

  async learn(agent: unknown, input: { filePath: string } & MemeMetadata, signal: AbortSignal): Promise<MemeItem> {
    this.assertAgent(agent);
    signal.throwIfAborted();
    if (typeof input.filePath !== 'string' || !isAbsolute(input.filePath)) throw new Error('请使用当前入站原图的绝对路径。');
    const source = await realpath(input.filePath);
    const root = await realpath(await this.collectionRoot(agent));
    let allowed = inRoot(root, source);
    if (!allowed) {
      for (const file of await this.options.allowedInputFiles?.(agent) ?? []) {
        try { if (await realpath(file) === source) { allowed = true; break; } } catch { /* stale input */ }
      }
    }
    if (!allowed) throw new Error('只能收藏当前会话实际收到的原件；其他本地图片请从管理页上传。');
    const info = await stat(source);
    if (!info.isFile() || info.size > this.maxImageBytes || info.size < 1) throw new Error('原图不可用或超出大小限制。');
    const bytes = await readFile(source);
    signal.throwIfAborted();
    return this.importImage(agent, bytes, basename(source), input, signal);
  }

  async update(agent: unknown, id: string, patch: Partial<MemeMetadata>): Promise<MemeItem> {
    const item = await this.locate(agent, id);
    if (item.builtin) throw new Error('内置图库只读，请先收藏后编辑。');
    const details = metadata({ caption: patch.caption ?? item.caption, tag: patch.tag ?? item.tag, keywords: patch.keywords ?? item.keywords });
    return this.serialized(item.root, async () => {
      const db = openIndexWriter(item.root);
      try { db.prepare('UPDATE memes SET tag = ?, caption = ?, keywords = ?, captioned_at = ? WHERE path = ?').run(details.tag, details.caption, details.keywords.join(' '), Date.now(), item.path); }
      finally { db.close(); }
      return { ...publicItem(item), ...details };
    });
  }

  /** Export the upstream-compatible index.db + manifest.json + indexed image format. */
  async exportZip(agent: unknown, options: { library?: 'collection' | 'builtin' } = {}): Promise<Buffer> {
    this.assertAgent(agent);
    if (options.library !== undefined && options.library !== 'collection' && options.library !== 'builtin') throw new Error('图库类型无效。');
    const builtin = options.library === 'builtin';
    const root = builtin ? this.builtinRoot : await this.collectionRoot(agent);
    return this.serialized(root, async () => {
      const store = new MemesStore(root);
      const rows = store.rows;
      store.close();
      if (!rows.length) throw new Error('当前图库为空，没有可导出的图片。');
      if (!builtin) {
        const writer = openIndexWriter(root);
        try { writer.exec('PRAGMA wal_checkpoint(FULL)'); } finally { writer.close(); }
      }
      const files: Array<{ name: string; data: Uint8Array }> = [
        { name: 'index.db', data: await readFile(join(root, 'index.db')) },
        { name: 'manifest.json', data: await readFile(join(root, 'manifest.json')) },
      ];
      let total = files.reduce((sum, entry) => sum + entry.data.byteLength, 0);
      for (const row of rows) {
        safeArchiveName(row.path);
        const path = await this.fileFor(agent, itemId(builtin, row.path));
        const bytes = await readFile(path);
        total += bytes.length;
        if (total > 64 * 1024 * 1024) throw new Error('导出图库超过64MiB，请分批整理。');
        files.push({ name: row.path, data: bytes });
      }
      return zipStore(files);
    });
  }

  /** Import an upstream pack or image-only ZIP into the current collection. */
  async importZip(agent: unknown, bytes: Uint8Array, signal?: AbortSignal): Promise<MemeZipImportResult> {
    this.assertAgent(agent);
    signal?.throwIfAborted();
    const entries = unzipBounded(bytes, { maxEntries: this.maxCollectionItems + 10, maxEntryBytes: this.maxImageBytes, maxTotalBytes: 64 * 1024 * 1024, maxArchiveBytes: 80 * 1024 * 1024 });
    const candidates: Array<{ bytes: Uint8Array; fileName: string; meta: MemeMetadata }> = [];
    const indexes = [...entries.keys()].filter((name) => name === 'index.db' || name.endsWith('/index.db'));
    let skipped = 0;
    if (indexes.length > 1) throw new Error('一次只允许导入一个图库索引。');
    if (indexes.length === 1) {
      const indexName = indexes[0]!;
      const prefix = indexName.slice(0, -'index.db'.length);
      const root = await this.collectionRoot(agent);
      const temp = await mkdtemp(join(root, '.zip-import-'));
      try {
        const indexFile = join(temp, 'index.db');
        await writeFile(indexFile, entries.get(indexName)!);
        const db = new DatabaseSync(indexFile, { readOnly: true });
        let rows: MemeRow[];
        try {
          db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF');
          const schema = db.prepare("SELECT type, sql FROM sqlite_schema WHERE name = 'memes'").get() as { type?: string; sql?: string } | undefined;
          if (schema?.type !== 'table' || !/^\s*CREATE\s+TABLE\b/iu.test(schema.sql || '')) throw new Error('ZIP 索引不是普通表情数据表。');
          const columns = db.prepare('PRAGMA table_xinfo(memes)').all() as Array<{ hidden?: number }>;
          if (columns.some((column) => column.hidden)) throw new Error('ZIP 索引不允许计算列。');
          rows = db.prepare("SELECT path, tag, file_name, caption, COALESCE(keywords, '') AS keywords FROM memes LIMIT ?").all(this.maxCollectionItems + 1) as unknown as MemeRow[];
        } finally { db.close(); }
        if (rows.length > this.maxCollectionItems) throw new Error('图库索引条目过多。');
        for (const row of rows) {
          const path = safeArchiveName(String(row.path));
          const image = entries.get(prefix + path);
          if (!image) { skipped++; continue; }
          imageExtension(image);
          const caption = String(row.caption || row.file_name || basename(path)).slice(0, 1000);
          const rawTag = String(row.tag || 'misc').toLowerCase();
          const meta = metadata({ caption, tag: /^[a-z0-9_-]{1,48}$/.test(rawTag) ? rawTag : 'misc', keywords: String(row.keywords || '').split(/[\s,，]+/u).filter(Boolean).slice(0, 30).map((word) => word.slice(0, 80)) });
          candidates.push({ bytes: image, fileName: basename(path), meta });
        }
      } finally {
        const actualRoot = await realpath(root);
        const actualTemp = await realpath(temp);
        if (!inRoot(actualRoot, actualTemp)) throw new Error('临时图库目录异常，拒绝清理。');
        await rm(actualTemp, { recursive: true, force: true });
      }
    } else {
      for (const [path, image] of entries) {
        if (path.endsWith('/') || !IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) { skipped++; continue; }
        imageExtension(image);
        const segments = path.split('/');
        const rawTag = segments.length > 1 ? segments[segments.length - 2]!.toLowerCase() : 'misc';
        const caption = basename(path).slice(0, -extname(path).length).slice(0, 1000) || '导入的表情';
        candidates.push({ bytes: image, fileName: basename(path), meta: metadata({ caption, tag: /^[a-z0-9_-]{1,48}$/.test(rawTag) ? rawTag : 'misc' }) });
      }
    }
    if (!candidates.length) throw new Error('ZIP 中没有可导入的真实图片。');
    if (candidates.length > this.maxCollectionItems) throw new Error('ZIP 图片数量超限。');
    // Validate the full archive before the first write; no untrusted archive path is extracted.
    for (const candidate of candidates) {
      if (candidate.bytes.byteLength > this.maxImageBytes || !IMAGE_EXTENSIONS.has(extname(candidate.fileName).toLowerCase())) throw new Error('ZIP 图片大小或文件名无效。');
    }
    const items: MemeItem[] = [];
    for (const candidate of candidates) {
      if (signal?.aborted) return { imported: items.length, items, skipped, complete: false, cancelled: true };
      try { items.push(await this.importImage(agent, candidate.bytes, candidate.fileName, candidate.meta, signal)); }
      catch (error) {
        if (!items.length) throw error;
        return { imported: items.length, items, skipped, complete: false, ...(signal?.aborted ? { cancelled: true } : { error: error instanceof Error ? error.message : '部分图片未导入' }) };
      }
    }
    return { imported: items.length, items, skipped, complete: true };
  }

  /** Administrator management operation; intentionally not an agent tool. */
  async delete(agent: unknown, id: string): Promise<{ deleted: true }> {
    const item = await this.locate(agent, id);
    if (item.builtin) throw new Error('内置图库只读。');
    return this.serialized(item.root, async () => {
      const file = await this.fileFor(agent, id);
      const db = openIndexWriter(item.root);
      try {
        await unlink(file);
        db.prepare('DELETE FROM memes WHERE path = ?').run(item.path);
      } finally { db.close(); }
      return { deleted: true };
    });
  }

  async dispose(): Promise<void> { await Promise.allSettled([...this.migrations.values(), ...this.queues.values()]); }
}

type ToolArgs = Record<string, unknown>;
const toolParameters = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = (description: string) => ({ type: 'string', description });
const listFields = { query: string('关键词，可使用中文。'), tag: string('情绪分类，例如 happy、sad、angry、like。'), limit: { type: 'integer', minimum: 1, maximum: 50 }, offset: { type: 'integer', minimum: 0 } };
const metadataFields = { caption: string('根据真实图片写出的描述，不会另行调用视觉模型。'), tag: string('英文情绪或分类标签。'), keywords: { type: 'array', items: { type: 'string' }, maxItems: 30 } };

/** Register the four native dsh-meme tool names once, without upstream's global routes. */
export function registerMemeTools(host: ModuleHost, options: MemeModuleOptions = {}): MemeModule {
  const module = new MemeModule(host, options);
  const tools = (host.ctx as unknown as { tools: { register(definition: unknown): unknown } }).tools;
  const register = (name: string, description: string, parameters: unknown, execute: (args: ToolArgs, exec: ModuleExecution) => Promise<unknown>) => {
    tools.register({ name, description, parameters,
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, result: unknown) => [{ type: 'text', text: JSON.stringify(result) }] },
      async execute(args: ToolArgs, exec: ModuleExecution) { exec.signal.throwIfAborted(); return execute(args, exec); },
    });
  };
  register('send_meme', '从内置大肥鱼图库及全对话共享收藏搜索表情。先 search 取得 id，确认描述后用 send 指定 id 发送。成功发送后不要重复输出图片路径或 [表情:] 标记；自主会话必须指定 target。',
    toolParameters({ ...listFields, action: { type: 'string', enum: ['search', 'send'] }, id: string('搜索返回的表情 id。'), target: string('省略时回复当前QQ会话；跨会话使用zeta_conversation_list返回的target。自主联系须指定已允许的c2c:openid或group:group_openid。') }),
    async (args, exec) => {
      const action = args.action ?? 'search';
      if (action === 'send') {
        if (typeof args.id !== 'string') throw new Error('发送表情需要先从搜索结果取得 id。');
        if (args.target !== undefined && typeof args.target !== 'string') throw new Error('target 无效。');
        return module.send(exec.agent, args.id, args.target as string | undefined, exec.signal);
      }
      if (action !== 'search') throw new Error('action 只能为 search 或 send。');
      return { ...await module.list(exec.agent, args as MemeListOptions), guidance: '这里只返回候选，尚未发送。选定后调用 send_meme action=send 并传 id；不要把路径或 [表情:] 标记写入 QQ 正文。' };
    });
  register('meme_list', '列出所有对话共用的表情，包含只读内置图库和共享收藏。', toolParameters(listFields), (args, exec) => module.list(exec.agent, args as MemeListOptions));
  register('meme_update', '修改共享收藏表情的分类、描述与关键词。内置图只读；删除在管理页操作。', toolParameters({ id: string('表情 id。'), ...metadataFields }, ['id']),
    async (args, exec) => {
      if (typeof args.id !== 'string') throw new Error('id 无效。');
      return { item: await module.update(exec.agent, args.id, args as unknown as Partial<MemeMetadata>) };
    });
  register('learn_meme', '收藏当前 QQ 会话实际收到的原始图片。根据你已经看见的图片提供 caption 和关键词；不会额外调用视觉模型。GIF 原件原样保留，已压成单帧的附件不能还原。',
    toolParameters({ file_path: string('当前入站原图绝对路径。'), ...metadataFields }, ['file_path', 'caption']),
    async (args, exec) => {
      if (typeof args.file_path !== 'string') throw new Error('file_path 无效。');
      return { item: await module.learn(exec.agent, { filePath: args.file_path, ...args } as unknown as { filePath: string } & MemeMetadata, exec.signal), learned: true, visualModelCalled: false };
    });
  host.ctx.effect(() => () => module.dispose());
  return module;
}
