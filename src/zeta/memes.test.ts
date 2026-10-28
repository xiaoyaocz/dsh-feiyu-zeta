import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import type { Context } from '@deepseek-ai/cordis';
import { openIndexWriter } from '../../vendor/dsh-meme/memes.js';
import { unzipBounded, zipStore } from '../../vendor/dsh-meme/zip.js';
import type { ConversationBinding, ModuleHost } from './contracts.ts';
import { MemeModule, registerMemeTools } from './memes.ts';

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zeta-memes-'));
  roots.push(root);
  const a = { id: 'a' }, b = { id: 'b' }, life = { id: 'life' };
  const bindings = new Map<unknown, ConversationBinding>([
    [a, { key: 'qqbot:app:c2c:a', appId: 'app', scope: 'c2c', peerId: 'a', sessionId: 'session-a' }],
    [b, { key: 'qqbot:app:group:b', appId: 'app', scope: 'group', peerId: 'b', sessionId: 'session-b' }],
  ]);
  const definitions = new Map<string, { execute(args: unknown, exec: unknown): Promise<Record<string, unknown>> }>();
  const sends: unknown[][] = [];
  const host: ModuleHost = {
    ctx: { tools: { register(def: { name: string; execute(args: unknown, exec: unknown): Promise<Record<string, unknown>> }) { definitions.set(def.name, def); } }, effect() {} } as unknown as Context,
    dataDir: root,
    bindingFor: (agent) => bindings.get(agent),
    isLifeAgent: (agent) => agent === life,
    async directoryFor(agent, kind) {
      const key = bindings.get(agent)?.key ?? (agent === life ? 'internal' : 'invalid');
      const dir = kind === 'memes' ? join(root, 'memes', 'shared') : join(root, kind, createHash('sha256').update(key).digest('hex').slice(0, 32));
      await mkdir(dir, { recursive: true });
      return dir;
    },
    async sendFile(...args) { sends.push(args); return { messageId: 'qq-real-receipt' }; },
    async sendText() { throw new Error('not used'); },
    async resolveApiKey() { throw new Error('not used'); },
  };
  return { root, a, b, life, bindings, definitions, sends, host };
}

describe('integrated dsh-meme', () => {
  it('ships the real 24-image upstream pack and performs Chinese keyword search', async () => {
    const f = await fixture();
    const module = new MemeModule(f.host);
    const all = await module.list(f.a, { limit: 50 });
    expect(all.total).toBe(24);
    expect(all.items.every((item) => item.builtin)).toBe(true);
    const first = all.items[0]!;
    expect((await readFile(await module.fileFor(f.a, first.id))).length).toBeGreaterThan(10);
    const query = first.caption.slice(0, 2);
    const found = await module.list(f.a, { query, limit: 50 });
    expect(found.items.some((item) => item.id === first.id)).toBe(true);
    expect(JSON.stringify(found)).not.toContain(f.root);
  });

  it('keeps actual GIF bytes, edits metadata and shares deduplicated content across conversations', async () => {
    const f = await fixture();
    const module = new MemeModule(f.host);
    const item = await module.importImage(f.a, GIF, 'animated.gif', { caption: '独有的开心动图', tag: 'happy', keywords: ['动图', '独有'] });
    expect(item.builtin).toBe(false);
    expect(await readFile(await module.fileFor(f.a, item.id))).toEqual(GIF);
    const repeated = await module.importImage(f.a, GIF, 'same.gif', { caption: '新的描述', tag: 'like' });
    expect(repeated.id).toBe(item.id);
    expect((await module.list(f.a, { limit: 50 })).total).toBe(25);
    expect((await module.list(f.b, { limit: 50 })).total).toBe(25);
    expect(await module.fileFor(f.b, item.id)).toBe(await module.fileFor(f.a, item.id));
    const changed = await module.update(f.a, item.id, { caption: '修改后的动图', keywords: ['喜欢'] });
    expect(changed.caption).toBe('修改后的动图');
    expect((await module.list(f.a, { query: '修改后' })).items[0]?.id).toBe(item.id);
    await module.delete(f.a, item.id);
    await expect(module.fileFor(f.a, item.id)).rejects.toThrow('不存在');
  });

  it('preserves a QQ collection across Session changes, independently of cwd/session id', async () => {
    const f = await fixture();
    const module = new MemeModule(f.host);
    const item = await module.importImage(f.a, GIF, 'a.gif', { caption: '收藏' });
    const resumed = { id: 'new-agent' };
    f.bindings.set(resumed, { ...f.bindings.get(f.a)!, sessionId: 'new-session' });
    expect(await module.fileFor(resumed, item.id)).toBe(await module.fileFor(f.a, item.id));
    await expect(module.list({ id: 'unbound' })).rejects.toThrow('没有可信');
  });

  it('learns only a trusted current input, rejects fake image bytes and respects cancellation', async () => {
    const f = await fixture();
    const input = join(f.root, 'current-input.gif');
    const other = join(f.root, 'another-person.gif');
    const fake = join(f.root, 'fake.png');
    await writeFile(input, GIF);
    await writeFile(other, GIF);
    await writeFile(fake, 'not an image');
    const module = new MemeModule(f.host, { allowedInputFiles: (agent) => agent === f.a ? [input, fake] : [] });
    const signal = new AbortController().signal;
    expect((await module.learn(f.a, { filePath: input, caption: '原始 GIF' }, signal)).fileName).toContain('.gif');
    await expect(module.learn(f.a, { filePath: other, caption: '不能偷读' }, signal)).rejects.toThrow('只能收藏当前会话');
    await expect(module.learn(f.b, { filePath: input, caption: '不能跨群' }, signal)).rejects.toThrow('只能收藏当前会话');
    await expect(module.learn(f.a, { filePath: fake, caption: '假图' }, signal)).rejects.toThrow('真实 PNG');
    const abort = new AbortController();
    abort.abort();
    await expect(module.learn(f.a, { filePath: input, caption: '取消' }, abort.signal)).rejects.toThrow();
  });

  it('does not report sent until the real sender settles, and requires an explicit autonomous target', async () => {
    const f = await fixture();
    let release: ((value: Record<string, unknown>) => void) | undefined;
    f.host.sendFile = async () => new Promise((resolve) => { release = resolve; });
    const module = new MemeModule(f.host);
    const id = (await module.list(f.a)).items[0]!.id;
    let settled = false;
    const pending = module.send(f.a, id, undefined, new AbortController().signal).then((value) => { settled = true; return value; });
    for (let i = 0; i < 20 && !release; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(release).toBeTypeOf('function');
    expect(settled).toBe(false);
    release!({ messageId: 'accepted' });
    expect((await pending).receipt.messageId).toBe('accepted');
    await expect(module.send(f.life, id, undefined, new AbortController().signal)).rejects.toThrow('指定联系目标');
    f.host.sendFile = async () => { throw new Error('QQ refused'); };
    await expect(module.send(f.a, id, undefined, new AbortController().signal)).rejects.toThrow('QQ refused');
  });

  it('protects the read-only builtin pack and rejects an index path escaping its own collection', async () => {
    const f = await fixture();
    const module = new MemeModule(f.host);
    const first = (await module.list(f.a)).items[0]!;
    await expect(module.update(f.a, first.id, { caption: 'overwrite' })).rejects.toThrow('只读');
    await expect(module.delete(f.a, first.id)).rejects.toThrow('只读');
    const collection = await f.host.directoryFor(f.a, 'memes');
    await module.list(f.a);
    const outside = join(collection, '..', 'outside.gif');
    await writeFile(outside, GIF);
    const db = openIndexWriter(collection);
    try { db.prepare('INSERT INTO memes(path,tag,file_name,caption,keywords) VALUES (?,?,?,?,?)').run('../outside.gif', 'misc', 'outside.gif', 'bad path', ''); }
    finally { db.close(); }
    const id = `collection:${Buffer.from('../outside.gif').toString('base64url')}`;
    await expect(module.fileFor(f.a, id)).rejects.toThrow('超出图库');
  });

  it('registers all four DSH tools with readable canonical results', async () => {
    const f = await fixture();
    registerMemeTools(f.host);
    expect([...f.definitions.keys()]).toEqual(['send_meme', 'meme_list', 'meme_update', 'learn_meme']);
    const result = await f.definitions.get('send_meme')!.execute({ action: 'search', limit: 2 }, { agent: f.a, signal: new AbortController().signal });
    expect(result.items).toHaveLength(2);
    expect(result.guidance).toContain('尚未发送');
    expect(f.sends).toHaveLength(0);
  });

  it('exports an upstream-compatible ZIP and imports into the shared collection', async () => {
    const f = await fixture();
    const module = new MemeModule(f.host);
    const first = await module.importImage(f.a, GIF, 'real.gif', { caption: '带元数据的动图', tag: 'happy', keywords: ['分享', '动图'] });
    const archive = await module.exportZip(f.a);
    const entries = unzipBounded(archive);
    expect(entries.has('index.db')).toBe(true);
    expect(entries.has('manifest.json')).toBe(true);
    const imported = await module.importZip(f.b, archive);
    expect(imported.complete).toBe(true);
    expect(imported.imported).toBe(1);
    expect(imported.items[0]?.caption).toBe('带元数据的动图');
    expect(await readFile(await module.fileFor(f.b, imported.items[0]!.id))).toEqual(GIF);
    await module.delete(f.a, first.id);
    expect((await module.list(f.b, { query: '带元数据' })).items).toHaveLength(0);
    const builtinZip = await module.exportZip(f.a, { library: 'builtin' });
    expect((await module.importZip(f.a, builtinZip)).imported).toBe(24);
  });

  it('supports ordinary DEFLATE image archives without extracting supplied paths', async () => {
    const f = await fixture();
    const module = new MemeModule(f.host);
    const original = zipStore([{ name: 'happy/animated.gif', data: GIF }]);
    const eocd = original.subarray(original.length - 22);
    const centralStart = eocd.readUInt32LE(16);
    const dataStart = 30 + original.readUInt16LE(26);
    const local = Buffer.from(original.subarray(0, dataStart));
    const central = Buffer.from(original.subarray(centralStart, original.length - 22));
    const compressed = deflateRawSync(GIF);
    local.writeUInt16LE(8, 8); local.writeUInt32LE(compressed.length, 18);
    central.writeUInt16LE(8, 10); central.writeUInt32LE(compressed.length, 20);
    const end = Buffer.from(eocd); end.writeUInt32LE(local.length + compressed.length, 16);
    const archive = Buffer.concat([local, compressed, central, end]);
    const result = await module.importZip(f.a, archive);
    expect(result.imported).toBe(1);
    expect(result.items[0]?.tag).toBe('happy');
    expect(await readFile(await module.fileFor(f.a, result.items[0]!.id))).toEqual(GIF);
  });

  it('rejects ZIP traversal, oversized declarations, duplicate entries and corrupt CRC before writing images', async () => {
    const f = await fixture();
    const module = new MemeModule(f.host);
    for (const name of ['../escape.gif', '/absolute.gif', 'C:/escape.gif', 'bad\\escape.gif']) {
      await expect(module.importZip(f.a, zipStore([{ name, data: GIF }]))).rejects.toThrow('路径');
    }
    await expect(module.importZip(f.a, zipStore([{ name: 'same.gif', data: GIF }, { name: 'same.gif', data: GIF }]))).rejects.toThrow('重复');
    const oversized = zipStore([{ name: 'a.gif', data: GIF }]);
    const central = oversized.readUInt32LE(oversized.length - 6);
    oversized.writeUInt32LE(20 * 1024 * 1024, central + 24);
    await expect(module.importZip(f.a, oversized)).rejects.toThrow('大小超限');
    const corrupt = zipStore([{ name: 'a.gif', data: GIF }]);
    corrupt[30 + corrupt.readUInt16LE(26) + 12]! ^= 1;
    await expect(module.importZip(f.a, corrupt)).rejects.toThrow('校验');
    expect((await module.list(f.a, { limit: 50 })).total).toBe(24);
  });
});
