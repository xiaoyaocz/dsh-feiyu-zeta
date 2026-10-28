import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync, gunzipSync } from 'node:zlib';
import * as tar from 'tar-stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractEncryptedArchive, writeEncryptedArchive, writeTarGzip, type ArchiveEntry } from './backup-archive.ts';

const PASSWORD = 'test-fixture-password-2026';
const signal = () => new AbortController().signal;
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'zeta-archive-test-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function entry(name: string, value: string | Buffer): ArchiveEntry {
  const data = Buffer.from(value);
  return { name, size: data.length, open: () => Readable.from([data]) };
}
async function stage(name = 'stage'): Promise<string> { const path = join(root, name); await mkdir(path, { mode: 0o700 }); return path; }
async function tarBytes(rows: Array<{ name: string; type?: tar.Header['type']; pax?: Record<string, string>; data?: string }>): Promise<Buffer> {
  const pack = tar.pack();
  const reading = (async () => { const parts: Buffer[] = []; for await (const chunk of pack) parts.push(Buffer.from(chunk)); return Buffer.concat(parts); })();
  for (const row of rows) pack.entry({ name: row.name, type: row.type ?? 'file', ...(row.pax ? { pax: row.pax } : {}), ...(row.type === 'symlink' || row.type === 'link' ? { linkname: '../external' } : {}) }, Buffer.from(row.data ?? (row.type && row.type !== 'file' ? '' : 'payload')));
  pack.finalize();
  return reading;
}
function encrypt(bytes: Buffer, password = PASSWORD): Buffer {
  const salt = randomBytes(16); const iv = randomBytes(12);
  const key = scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  try { return Buffer.concat([Buffer.from('ZETABK01'), salt, iv, cipher.update(gzipSync(bytes)), cipher.final(), cipher.getAuthTag()]); }
  finally { key.fill(0); }
}
async function hostile(rows: Parameters<typeof tarBytes>[0]): Promise<string> {
  const path = join(root, 'hostile.zeta'); await writeFile(path, encrypt(await tarBytes(rows))); return path;
}

describe('private streaming backup archive', () => {
  it('encrypts all tar names and contents, round-trips Unicode PAX paths, empty files and hashes', async () => {
    const secret = 'private configuration and original complete chat events';
    const archive = join(root, 'backup.zeta');
    const result = await writeEncryptedArchive([entry('manifest.json', secret), entry('聊天/私聊.json', '你好\n这是原文'), entry('code/empty.ts', '')], archive, PASSWORD, signal());
    const bytes = await readFile(archive);
    expect(bytes.subarray(0, 8).toString()).toBe('ZETABK01');
    expect(bytes.includes(Buffer.from(secret))).toBe(false);
    expect(bytes.includes(Buffer.from('manifest.json'))).toBe(false);
    expect(result).toEqual({ files: 3, bytes: bytes.length });
    // Independent decryption fixes the envelope offsets, KDF and cipher contract.
    const key = scryptSync(PASSWORD, bytes.subarray(8, 24), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(24, 36));
    decipher.setAuthTag(bytes.subarray(-16));
    const raw = gunzipSync(Buffer.concat([decipher.update(bytes.subarray(36, -16)), decipher.final()])); key.fill(0);
    expect(raw.includes(Buffer.from(secret))).toBe(true);
    const directory = await stage();
    const extracted = await extractEncryptedArchive(archive, directory, PASSWORD, signal());
    expect(extracted.files.map(file => file.name)).toEqual(['manifest.json', '聊天/私聊.json', 'code/empty.ts']);
    expect(await readFile(join(directory, '聊天/私聊.json'), 'utf8')).toBe('你好\n这是原文');
    expect(extracted.files[0]?.sha256).toBe(createHash('sha256').update(secret).digest('hex'));
    expect(extracted.bytes).toBe(Buffer.byteLength(secret) + Buffer.byteLength('你好\n这是原文'));
  });

  it('uses fresh salt and IV for each archive', async () => {
    const first = join(root, 'first'); const second = join(root, 'second');
    await writeEncryptedArchive([entry('a', 'same')], first, PASSWORD, signal());
    await writeEncryptedArchive([entry('a', 'same')], second, PASSWORD, signal());
    expect((await readFile(first)).subarray(8, 36).equals((await readFile(second)).subarray(8, 36))).toBe(false);
  });

  it.each(['incorrect-password', 'bad-tag', 'truncated'])('refuses %s and removes only its own staged plaintext', async kind => {
    const archive = join(root, 'backup');
    await writeEncryptedArchive([entry('nested/chat.json', 'private'.repeat(10000))], archive, PASSWORD, signal());
    const original = await readFile(archive);
    if (kind === 'bad-tag') { const broken = Buffer.from(original); broken[broken.length - 1] = broken[broken.length - 1]! ^ 1; await writeFile(archive, broken); }
    if (kind === 'truncated') await writeFile(archive, original.subarray(0, original.length - 17));
    const suppliedArchive = await readFile(archive);
    const directory = await stage();
    await expect(extractEncryptedArchive(archive, directory, kind === 'incorrect-password' ? 'wrong-password' : PASSWORD, signal())).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
    expect(await readFile(archive)).toEqual(suppliedArchive);
  });

  it.each(['../outside', '/absolute', 'C:/absolute', 'dir\\escape', 'safe/../escape', 'dir/file:ads', 'NUL.txt', 'folder/COM¹.txt', 'a./file', 'a /file', 'a\0b', 'a//b'])('refuses unsafe writer path %j before opening its source', async name => {
    const open = vi.fn(() => Readable.from(['x'])); const path = join(root, 'invalid');
    await expect(writeEncryptedArchive([{ name, size: 1, open }], path, PASSWORD, signal())).rejects.toThrow(/unsafe/u);
    expect(open).not.toHaveBeenCalled();
    await expect(readFile(path)).rejects.toThrow();
  });

  it.each([['same', 'SAME'], ['a', 'a/b'], ['Dir/a', 'dir/b']])('refuses duplicate or conflicting names %j', async (first, second) => {
    const path = join(root, 'duplicate');
    await expect(writeEncryptedArchive([entry(first, 'one'), entry(second, 'two')], path, PASSWORD, signal())).rejects.toThrow(/duplicate|conflicting/u);
    await expect(readFile(path)).rejects.toThrow();
  });

  it.each([
    [{ name: '../escape' }],
    [{ name: 'safe', pax: { path: '../pax-escape' } }],
    [{ name: 'safe', pax: { linkpath: '../pax-link' } }],
    [{ name: 'safe', pax: { 'GNU.sparse.map': '0,1' } }],
    [{ name: 'safe', type: 'symlink' as const }],
    [{ name: 'safe', type: 'link' as const }],
    [{ name: 'safe', type: 'directory' as const, data: '' }],
    [{ name: 'same' }, { name: 'SAME' }],
  ].map(rows => ({ rows })))('rejects authenticated malicious tar paths, links, sparse metadata and duplicates %#', async ({ rows }) => {
    const source = await hostile(rows); const directory = await stage();
    await expect(extractEncryptedArchive(source, directory, PASSWORD, signal())).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
    expect(await readdir(root)).not.toContain('escape');
  });

  it('refuses oversized and misdeclared entries without retaining incomplete output', async () => {
    const open = vi.fn(() => Readable.from([])); const large = join(root, 'large');
    await expect(writeEncryptedArchive([{ name: 'large', size: 256 * 1024 * 1024 + 1, open }], large, PASSWORD, signal())).rejects.toThrow(/256 MiB/u);
    expect(open).not.toHaveBeenCalled();
    const short = join(root, 'short');
    await expect(writeEncryptedArchive([{ name: 'short', size: 100, open: () => Readable.from(['tiny']) }], short, PASSWORD, signal())).rejects.toThrow(/size|length|mismatch/iu);
    const long = join(root, 'long');
    await expect(writeEncryptedArchive([{ name: 'long', size: 1, open: () => Readable.from(['larger']) }], long, PASSWORD, signal())).rejects.toThrow(/size|limit/iu);
    await expect(readFile(large)).rejects.toThrow(); await expect(readFile(short)).rejects.toThrow(); await expect(readFile(long)).rejects.toThrow();
  });

  it('refuses an authenticated oversized reader header before allocating the declared body', async () => {
    const raw = await tarBytes([{ name: 'oversized.bin', data: '' }]);
    raw.write((256 * 1024 * 1024 + 1).toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    raw.fill(32, 148, 156);
    const checksum = raw.subarray(0, 512).reduce((sum, value) => sum + value, 0);
    raw.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    const archive = join(root, 'oversized-reader'); await writeFile(archive, encrypt(raw));
    const directory = await stage();
    await expect(extractEncryptedArchive(archive, directory, PASSWORD, signal())).rejects.toThrow(/256 MiB/u);
    expect(await readdir(directory)).toEqual([]);
  });

  it('rejects authenticated data appended after the canonical tar end marker', async () => {
    const archive = join(root, 'trailing-data');
    await writeFile(archive, encrypt(Buffer.concat([await tarBytes([{ name: 'a' }]), Buffer.alloc(512, 1)])));
    const directory = await stage();
    await expect(extractEncryptedArchive(archive, directory, PASSWORD, signal())).rejects.toThrow(/end marker/u);
    expect(await readdir(directory)).toEqual([]);
  });

  it('never overwrites an existing output file or extracts into a nonempty directory', async () => {
    const archive = join(root, 'existing'); await writeFile(archive, 'original');
    await expect(writeEncryptedArchive([entry('a', 'b')], archive, PASSWORD, signal())).rejects.toThrow();
    expect(await readFile(archive, 'utf8')).toBe('original');
    const directory = await stage(); await writeFile(join(directory, 'keep.txt'), 'keep');
    await expect(extractEncryptedArchive(archive, directory, PASSWORD, signal())).rejects.toThrow(/empty directory/u);
    expect(await readFile(join(directory, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('cancels an in-flight source, destroys it, removes its output and rejects promptly', async () => {
    const controller = new AbortController(); let source!: Readable;
    let opened!: () => void; const ready = new Promise<void>(accept => { opened = accept; });
    const archive = join(root, 'cancelled');
    const operation = writeEncryptedArchive([{ name: 'hanging', size: 20, open: () => { source = new Readable({ read() {} }); opened(); return source; } }], archive, PASSWORD, controller.signal);
    await ready; controller.abort(new Error('fixture cancelled'));
    await expect(operation).rejects.toThrow();
    expect(source.destroyed).toBe(true);
    await expect(readFile(archive)).rejects.toThrow();
  });

  it('honors pre-aborted reads and validates password bounds', async () => {
    const controller = new AbortController(); controller.abort(new Error('stopped'));
    await expect(extractEncryptedArchive(join(root, 'absent'), await stage(), PASSWORD, controller.signal)).rejects.toThrow('stopped');
    for (const password of ['short', 'x'.repeat(1025), undefined as never]) await expect(writeEncryptedArchive([], join(root, 'invalid-password'), password, signal())).rejects.toThrow(/password/u);
  });

  it('cancels even while an asynchronous entry iterator is waiting for its next item', async () => {
    const controller = new AbortController(); let requested!: () => void;
    const ready = new Promise<void>(accept => { requested = accept; });
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    const entries: AsyncIterable<ArchiveEntry> = { [Symbol.asyncIterator]: () => ({ next: () => { requested(); return new Promise(() => {}); }, return: returned }) };
    const archive = join(root, 'waiting-iterator'); const operation = writeEncryptedArchive(entries, archive, PASSWORD, controller.signal);
    await ready; controller.abort(new Error('cancel pending iterator'));
    await expect(operation).rejects.toThrow(); expect(returned).toHaveBeenCalledOnce();
    await expect(readFile(archive)).rejects.toThrow();
  });

  it('writes public npm tar.gz with only package-prefixed entries and the same path guards', async () => {
    const archive = join(root, 'plugin.tgz');
    await expect(writeTarGzip([entry('package/package.json', '{"name":"fixture"}'), entry('package/src/入口.ts', 'export {}')], archive, signal())).resolves.toMatchObject({ files: 2 });
    const raw = gunzipSync(await readFile(archive)); expect(raw.includes(Buffer.from('package/package.json'))).toBe(true);
    const bad = join(root, 'bad.tgz');
    await expect(writeTarGzip([entry('private-data', 'secret')], bad, signal())).rejects.toThrow(/package\//u);
    await expect(readFile(bad)).rejects.toThrow();
  });
});
