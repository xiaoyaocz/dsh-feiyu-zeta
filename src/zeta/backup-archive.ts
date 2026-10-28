import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import * as tar from 'tar-stream';

export interface ArchiveEntry { name: string; size: number; open: () => Readable }
type Entries = AsyncIterable<ArchiveEntry> | Iterable<ArchiveEntry>;
interface WriteResult { bytes: number; files: number }
interface ExtractedFile { name: string; path: string; size: number; sha256: string }
const MAGIC = Buffer.from('ZETABK01', 'ascii');
const HEADER_BYTES = 8 + 16 + 12;
const TAG_BYTES = 16;
const MAX_ENTRY = 256 * 1024 * 1024;
const MAX_TOTAL = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE = MAX_TOTAL;
const MAX_FILES = 20_000;
const MAX_PAX = 64 * 1024;

function failure(message: string): Error { return new Error(`Archive: ${message}`); }
function errorOf(value: unknown): Error { return value instanceof Error ? value : failure('operation failed'); }
function checkPassword(password: string): void {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024) throw failure('password must contain 8 to 1024 characters');
}
async function deriveKey(password: string, salt: Buffer, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  const key = await new Promise<Buffer>((accept, reject) => {
    scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, value) => error ? reject(error) : accept(value));
  });
  if (signal.aborted) { key.fill(0); signal.throwIfAborted(); }
  return key;
}

/** Use one portable spelling; never reinterpret backslashes or Windows names. */
function safeName(name: string): string {
  if (typeof name !== 'string' || !name || Buffer.byteLength(name) > 4096 || /[\\\x00-\x1f\x7f-\x9f<>:"|?*\ufffd]/u.test(name) || isAbsolute(name)) throw failure('unsafe entry path');
  const parts = name.split('/');
  if (parts.length > 128 || parts.some(part => {
    const portable = part.normalize('NFKC');
    return !part || part === '.' || part === '..' || /[ .]$/u.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$|conin\$|conout\$)(?:\.|$)/iu.test(portable);
  })) throw failure('unsafe entry path');
  return name;
}
function safeSize(size: number): number {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ENTRY) throw failure('entry size exceeds the 256 MiB limit or is invalid');
  return size;
}
class Names {
  private readonly used = new Map<string, { name: string; file: boolean }>();
  files = 0;
  bytes = 0;
  add(name: string, size: number): void {
    safeName(name); safeSize(size);
    if (this.files >= MAX_FILES) throw failure('file count exceeds the 20000 limit');
    if (this.bytes + size > MAX_TOTAL) throw failure('expanded content exceeds the 2 GiB limit');
    const parts = name.split('/');
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join('/');
      const key = prefix.normalize('NFKC').toLowerCase();
      const prior = this.used.get(key);
      const file = index === parts.length;
      if (prior && (prior.file || file || prior.name !== prefix)) throw failure('duplicate or conflicting entry path (including case variants)');
      if (!prior) this.used.set(key, { name: prefix, file });
    }
    this.files++;
    this.bytes += size;
  }
}
class ByteLimit extends Transform {
  bytes = 0;
  constructor(private readonly maximum: number, private readonly exact = false, private readonly hash?: ReturnType<typeof createHash>) { super(); }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maximum) { callback(failure('actual stream size exceeds its limit')); return; }
    this.hash?.update(chunk);
    callback(null, chunk);
  }
  override _flush(callback: TransformCallback): void {
    callback(this.exact && this.bytes !== this.maximum ? failure('entry byte length does not match its declared size') : undefined);
  }
}
/** The caller owns this handle; stream completion never waits on handle.close(). */
class HandleWriter extends Writable {
  constructor(private readonly file: FileHandle) { super(); }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    void (async () => {
      let offset = 0;
      while (offset < chunk.length) {
        const result = await this.file.write(chunk, offset, chunk.length - offset);
        if (!result.bytesWritten) throw failure('file write made no progress');
        offset += result.bytesWritten;
      }
    })().then(() => callback(), error => callback(errorOf(error)));
  }
}

/** Inspect physical headers as well as tar-stream's PAX-resolved entry names. */
class TarGuard extends Transform {
  private readonly header = Buffer.alloc(512);
  private filled = 0;
  private remaining = 0;
  private zeros = 0;
  private pax = false;
  private files = 0;
  private bytes = 0;
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (this.remaining) { const skip = Math.min(this.remaining, chunk.length - offset); this.remaining -= skip; offset += skip; continue; }
        const length = Math.min(512 - this.filled, chunk.length - offset);
        chunk.copy(this.header, this.filled, offset); this.filled += length; offset += length;
        if (this.filled !== 512) continue;
        this.filled = 0;
        if (this.header.every(value => value === 0)) { this.zeros++; continue; }
        if (this.zeros) throw failure('data follows the tar end marker');
        if (this.header.toString('ascii', 257, 263) !== 'ustar\0') throw failure('unsupported tar format');
        const type = this.header[156];
        if (type !== 0 && type !== 48 && type !== 120) throw failure('only regular files and local path PAX metadata are allowed; links and sparse files are refused');
        if (this.header.subarray(157, 257).some(value => value !== 0)) throw failure('tar link targets are forbidden');
        const name = this.header.subarray(0, 100).toString('utf8').split('\0', 1)[0]!;
        const prefix = this.header.subarray(345, 500).toString('utf8').split('\0', 1)[0]!;
        safeName(prefix ? `${prefix}/${name}` : name);
        const sizeText = this.header.toString('ascii', 124, 136).replace(/\0.*$/s, '').trim();
        if (!/^[0-7]+$/u.test(sizeText)) throw failure('unsupported tar size encoding');
        const size = Number.parseInt(sizeText, 8);
        if (type === 120) {
          if (this.pax || size > MAX_PAX) throw failure('invalid or excessive PAX metadata');
          this.pax = true;
        } else {
          safeSize(size);
          if (++this.files > MAX_FILES || (this.bytes += size) > MAX_TOTAL) throw failure('tar content exceeds archive limits');
          this.pax = false;
        }
        this.remaining = Math.ceil(size / 512) * 512;
      }
      callback(null, chunk);
    } catch (error) { callback(errorOf(error)); }
  }
  override _flush(callback: TransformCallback): void {
    callback(this.filled || this.remaining || this.pax || this.zeros < 2 ? failure('truncated tar archive') : undefined);
  }
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((accept, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(accept, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function feed(entries: Entries, pack: tar.Pack, names: Names, signal: AbortSignal, npm: boolean): Promise<void> {
  const iterator: AsyncIterator<ArchiveEntry> | Iterator<ArchiveEntry> = Symbol.asyncIterator in entries ? entries[Symbol.asyncIterator]() : entries[Symbol.iterator]();
  try {
    while (true) {
      const next = await abortable(Promise.resolve(iterator.next()), signal);
      if (next.done) break;
      const entry = next.value;
      names.add(entry.name, entry.size);
      if (npm && !entry.name.startsWith('package/')) throw failure('npm archive entries must be below package/');
      signal.throwIfAborted();
      const source = entry.open();
      if (!(source instanceof Readable)) throw failure('entry source must be a Readable');
      try {
        const target = pack.entry({ name: entry.name, size: entry.size, type: 'file', mode: 0o600, uid: 0, gid: 0, mtime: new Date(0) });
        await pipeline(source, new ByteLimit(entry.size, true), target, { signal });
      } catch (error) { source.destroy(); throw error; }
    }
    pack.finalize();
  } finally {
    // Do not let an uncooperative caller-owned iterator keep cancellation pending.
    if (iterator.return) void Promise.resolve(iterator.return()).catch(() => {});
  }
}
async function settle(tasks: Promise<unknown>[], controller: AbortController): Promise<void> {
  let first: unknown;
  const observed = tasks.map(task => task.catch(error => { if (first === undefined) first = error; controller.abort(error); throw error; }));
  await Promise.allSettled(observed);
  if (first !== undefined) throw first;
}

async function writeArchive(entries: Entries, destination: string, signal: AbortSignal, password?: string): Promise<WriteResult> {
  if (password !== undefined) checkPassword(password);
  signal.throwIfAborted();
  let key: Buffer | undefined;
  let output: FileHandle | undefined;
  let completed = false;
  const controller = new AbortController();
  const operationSignal = AbortSignal.any([signal, controller.signal]);
  try {
    const salt = password === undefined ? undefined : randomBytes(16);
    const iv = password === undefined ? undefined : randomBytes(12);
    if (password !== undefined) key = await deriveKey(password, salt!, operationSignal);
    output = await open(destination, 'wx', 0o600);
    const writer = new HandleWriter(output);
    const pack = tar.pack();
    const names = new Names();
    const counter = new ByteLimit(MAX_ARCHIVE);
    const expanded = new ByteLimit(MAX_TOTAL);
    const gzip = createGzip();
    let stream: Promise<void>;
    if (key) {
      const cipher = createCipheriv('aes-256-gcm', key, iv!);
      const header = Buffer.concat([MAGIC, salt!, iv!]);
      let prefixed = false;
      const envelope = new Transform({
        transform(chunk, _encoding, callback) { if (!prefixed) { this.push(header); prefixed = true; } callback(null, chunk); },
        flush(callback) { if (!prefixed) this.push(header); this.push(cipher.getAuthTag()); callback(); },
      });
      stream = pipeline(pack, expanded, gzip, cipher, envelope, counter, writer, { signal: operationSignal });
    } else stream = pipeline(pack, expanded, gzip, counter, writer, { signal: operationSignal });
    await settle([stream, feed(entries, pack, names, operationSignal, password === undefined)], controller);
    await output.sync();
    await output.close(); output = undefined;
    completed = true;
    return { bytes: counter.bytes, files: names.files };
  } finally {
    key?.fill(0);
    if (output) { await output.close().catch(() => {}); if (!completed) await unlink(destination).catch(() => {}); }
  }
}

/** Private backup envelope: magic || salt || IV || encrypted(tar.gz) || GCM tag. */
export async function writeEncryptedArchive(entries: Entries, destination: string, password: string, signal: AbortSignal): Promise<WriteResult> {
  checkPassword(password);
  return writeArchive(entries, destination, signal, password);
}
/** Public distributable code archive; all entries must use npm's package/ prefix. */
export function writeTarGzip(entries: Entries, destination: string, signal: AbortSignal): Promise<WriteResult> {
  return writeArchive(entries, destination, signal);
}

async function readAt(file: FileHandle, size: number, position: number): Promise<Buffer> {
  const data = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) { const result = await file.read(data, offset, size - offset, position + offset); if (!result.bytesRead) throw failure('truncated encrypted archive'); offset += result.bytesRead; }
  return data;
}
async function extractionRoot(destination: string): Promise<string> {
  const info = await lstat(destination);
  if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(destination)).length) throw failure('extraction destination must be a private empty directory');
  return realpath(destination);
}
async function parentDirectories(root: string, target: string, created: Set<string>): Promise<void> {
  const parts = relative(root, dirname(target)).split(/[\\/]/u).filter(Boolean);
  let parent = root;
  for (const part of parts) {
    parent = join(parent, part);
    if (created.has(parent)) {
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) throw failure('extraction parent changed');
    } else { await mkdir(parent, { mode: 0o700 }); created.add(parent); }
  }
}
function resolvedEntryName(header: tar.Header): string {
  if (header.type !== 'file' || header.linkname) throw failure('only regular files are allowed');
  const pax = header.pax;
  if (pax !== null && pax !== undefined) {
    if (typeof pax !== 'object' || Array.isArray(pax) || Object.keys(pax).some(key => key !== 'path')) throw failure('unsupported PAX metadata, link or sparse entry');
    const path = (pax as { path?: unknown }).path;
    if (path !== undefined) { if (typeof path !== 'string') throw failure('invalid PAX path'); safeName(path); }
  }
  return safeName(header.name);
}

/** Extract into the caller's newly-created private empty staging directory. */
export async function extractEncryptedArchive(source: string, destination: string, password: string, signal: AbortSignal): Promise<{ files: ExtractedFile[]; bytes: number }> {
  checkPassword(password); signal.throwIfAborted();
  const root = await extractionRoot(destination);
  const createdFiles: string[] = [];
  const directories = new Set<string>();
  const files: ExtractedFile[] = [];
  const names = new Names();
  const controller = new AbortController();
  const operationSignal = AbortSignal.any([signal, controller.signal]);
  let key: Buffer | undefined;
  const input = await open(source, 'r');
  try {
    const info = await input.stat();
    if (!info.isFile() || info.size > MAX_ARCHIVE || info.size <= HEADER_BYTES + TAG_BYTES) throw failure('encrypted source size is invalid or exceeds 2 GiB');
    const header = await readAt(input, HEADER_BYTES, 0);
    if (!header.subarray(0, 8).equals(MAGIC)) throw failure('unrecognized backup format');
    const tag = await readAt(input, TAG_BYTES, info.size - TAG_BYTES);
    key = await deriveKey(password, header.subarray(8, 24), operationSignal);
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(24));
    decipher.setAuthTag(tag);
    const unpack = tar.extract();
    const ciphertext = createReadStream(source, { fd: input.fd, start: HEADER_BYTES, end: info.size - TAG_BYTES - 1, autoClose: false });
    const transport = pipeline(ciphertext, decipher, createGunzip(), new ByteLimit(MAX_TOTAL), new TarGuard(), unpack, { signal: operationSignal });
    const consume = (async () => {
      for await (const entry of unpack) {
        operationSignal.throwIfAborted();
        const name = resolvedEntryName(entry.header);
        const size = safeSize(entry.header.size ?? 0);
        names.add(name, size);
        const target = resolve(root, ...name.split('/'));
        const rel = relative(root, target);
        if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw failure('entry escapes destination');
        await parentDirectories(root, target, directories);
        const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        createdFiles.push(target);
        try {
          const hash = createHash('sha256');
          await pipeline(entry, new ByteLimit(size, true, hash), new HandleWriter(file), { signal: operationSignal });
          files.push({ name, path: target, size, sha256: hash.digest('hex') });
        } finally { await file.close(); }
      }
    })();
    // Decipher.final() authenticates the complete encrypted payload before this
    // promise can fulfill. Staged plaintext is discarded on any failure.
    await settle([transport, consume], controller);
    operationSignal.throwIfAborted();
    return { files, bytes: names.bytes };
  } catch (error) {
    controller.abort(error);
    for (const file of createdFiles.toReversed()) await unlink(file).catch(() => {});
    for (const directory of [...directories].reverse()) await rmdir(directory).catch(() => {});
    throw error;
  } finally { key?.fill(0); await input.close().catch(() => {}); }
}
