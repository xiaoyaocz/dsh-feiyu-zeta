import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { Session, SessionId, SessionLogOffset, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';
import { assertStoredId, assertVersion, materializeAppendBatch, materializeCreateHeader, SessionPersistenceNotFoundError, validateStoredEvents, type SessionHandle } from '@deepseek-ai/dsh-session-persistence';

export const MAX_SESSION_TRANSFER_BYTES = 256 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 2 * 1024 ** 3;
const READ_BATCH = 128;
export interface SessionTransferEntry { id: string; path: string; header: SessionHeader; inheritedEventCount: number; eventCount: number }
export type AttachmentTransferEntry = { kind: 'image'; ref: ImageAttachmentRef; path: string } | { kind: 'file'; ref: FileAttachmentRef; path: string };
export interface SessionTransferExport { sessions: SessionTransferEntry[]; attachments: AttachmentTransferEntry[]; warnings: string[] }
export interface ValidatedSessionEntry extends SessionTransferEntry { sourceHeader: SessionHeader; sourceFile: string; sha256: string }
export type ValidatedAttachmentEntry = AttachmentTransferEntry & { sourceFile: string; sha256: string };
export interface ValidatedSessionTransfer { sessions: readonly ValidatedSessionEntry[]; attachments: readonly ValidatedAttachmentEntry[]; warnings: readonly string[]; conflicts: readonly string[]; cwdRoot: string }
interface SessionDocument { header: SessionHeader; inheritedEventCount: number; events: SessionEvent[] }
const validatedPlans = new WeakSet<ValidatedSessionTransfer>();
const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const fail = (message: string): never => { throw new Error(`会话备份：${message}`); };
function fileDigest(ref: FileAttachmentRef): string { return /^sha256:([a-f0-9]{64})$/u.exec(ref.attachmentId)?.[1] ?? fail('文件附件内容标识无效'); }

/** Same source directory maps to the same new workspace, across sessions and QQ config. */
export function mappedWorkspace(cwdRoot: string, oldCwd?: string): string {
  if (!isAbsolute(cwdRoot)) fail('新的工作目录必须使用绝对路径');
  return resolve(cwdRoot, hash(oldCwd || ''));
}

function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f]/u.test(value); }
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0); }
function refKey(value: AttachmentTransferEntry): string { return value.kind === 'file' ? `file:${value.ref.attachmentId}:${value.ref.name}` : `image:${value.ref.attachmentId}`; }
function coreRef(value: AttachmentTransferEntry): unknown {
  return value.kind === 'file' ? { attachmentId: value.ref.attachmentId, name: value.ref.name, bytes: value.ref.bytes }
    : { attachmentId: value.ref.attachmentId, bytes: value.ref.bytes, mediaType: value.ref.mediaType, width: value.ref.width, height: value.ref.height };
}
function validateRef(value: AttachmentTransferEntry): void {
  if (!value || (value.kind !== 'image' && value.kind !== 'file') || !value.ref || !validId(value.ref.attachmentId) || !integer(value.ref.bytes) || value.ref.bytes > MAX_ATTACHMENT_BYTES) fail('附件引用无效或超过2 GiB');
  if (value.kind === 'file') {
    fileDigest(value.ref);
    if (typeof value.ref.name !== 'string' || !value.ref.name || /[/\\\u0000-\u001f]/u.test(value.ref.name)) fail('文件附件名称无效');
  } else {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(value.ref.mediaType) || !integer(value.ref.width) || !value.ref.width || !integer(value.ref.height) || !value.ref.height || value.ref.bytes > MAX_SESSION_TRANSFER_BYTES) fail('图片附件格式、尺寸或大小无效');
    if (value.ref.originalDimensions && (!integer(value.ref.originalDimensions.width) || !value.ref.originalDimensions.width || !integer(value.ref.originalDimensions.height) || !value.ref.originalDimensions.height)) fail('图片的原始尺寸无效');
  }
}

/** Only actual native message content is scanned; text paths and tool-private JSON are opaque. */
function refsIn(events: readonly SessionEvent[]): AttachmentTransferEntry[] {
  const found = new Map<string, AttachmentTransferEntry>();
  for (const event of events) {
    const data = event.data as unknown as { content?: unknown; message?: { content?: unknown } };
    const content = event.type === 'user/message' ? data.content
      : ['assistant/message', 'developer/message', 'system/message', 'tool/result'].includes(event.type) ? data.message?.content : undefined;
    if (!Array.isArray(content)) continue;
    for (const raw of content) {
      if (!raw || typeof raw !== 'object' || (raw.type !== 'image' && raw.type !== 'file')) continue;
      const ref = { kind: raw.type, ref: structuredClone(raw.attachment), path: '' } as AttachmentTransferEntry;
      validateRef(ref);
      const key = refKey(ref); const prior = found.get(key);
      if (prior && !isDeepStrictEqual(coreRef(prior), coreRef(ref))) fail('同一附件标识的内容描述不一致');
      if (!prior) found.set(key, ref);
    }
  }
  return [...found.values()];
}

async function writeBytes(handle: FileHandle, data: Uint8Array, signal: AbortSignal): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    signal.throwIfAborted();
    const result = await handle.write(data, offset, data.length - offset, null);
    if (!result.bytesWritten) fail('暂存文件写入未取得进展');
    offset += result.bytesWritten;
  }
}

async function readChunks(handle: SessionHandle, signal: AbortSignal, consume: (events: readonly SessionEvent[]) => Promise<void>): Promise<number> {
  let offset = 0;
  for (;;) {
    signal.throwIfAborted();
    const value = await handle.read(offset, READ_BATCH, { signal });
    if (!Array.isArray(value.events) || value.events.length > READ_BATCH) fail('原生存储返回的日志分片无效');
    if (!value.events.length) return offset;
    for (let i = 0; i < value.events.length; i++) if (value.events[i]?.seq !== offset + i) fail('原生日志不是连续的完整前缀');
    await consume(value.events); offset += value.events.length;
  }
}

async function selectedHeaders(ctx: Context, roots: readonly string[], signal: AbortSignal): Promise<Map<string, SessionHeader>> {
  if (roots.some(id => !validId(id))) fail('选中的会话标识无效');
  const selected = new Set(roots); const stopped = new Set<unknown>(); let headers = new Map<string, SessionHeader>();
  for (let pass = 0; pass < 32; pass++) {
    signal.throwIfAborted();
    headers = new Map((await ctx.sessionPersistence.list({ signal })).map(value => [String(value.header.id), value.header]));
    for (const session of ctx.sessions.list()) if (!headers.has(session.id)) headers.set(session.id, session.header);
    let grew: boolean;
    do {
      grew = false;
      for (const [id, header] of headers) if (!selected.has(id) && header.parentSession && selected.has(header.parentSession)) { selected.add(id); grew = true; }
    } while (grew);
    const active = [...selected].map(id => ctx.agents.get(SessionId(id))).filter(agent => agent && (!stopped.has(agent) || agent.status === 'running'));
    if (!active.length) return new Map([...selected].flatMap(id => headers.has(id) ? [[id, headers.get(id)!] as const] : []));
    for (const agent of active) { stopped.add(agent); agent!.cancel({ kind: 'user' }); }
    await Promise.all(active.map(agent => agent!.whenIdle()));
  }
  return fail('相关子会话仍持续创建，未能取得稳定快照，请稍后重试');
}

/** Exports a raw persistence prefix, without SessionQuery repair or Agent activation. */
export async function exportSessions(ctx: Context, rootIds: string[], stageDir: string, signal: AbortSignal): Promise<SessionTransferExport> {
  const root = await realpath(stageDir); const headers = await selectedHeaders(ctx, [...new Set(rootIds)], signal);
  const warnings = rootIds.filter(id => !headers.has(id)).map(id => `预留会话 ${id} 尚无持久记录，已跳过`);
  const result: SessionTransferExport = { sessions: [], attachments: [], warnings };
  await mkdir(resolve(root, 'sessions'), { recursive: true, mode: 0o700 }); await mkdir(resolve(root, 'attachments'), { recursive: true, mode: 0o700 });
  const refs = new Map<string, AttachmentTransferEntry>();
  for (const [id] of headers) {
    signal.throwIfAborted(); const live = ctx.sessions.get(SessionId(id)); if (live) await ctx.sessions.flush(live);
    let source: SessionHandle;
    try { source = await ctx.sessionPersistence.open(SessionId(id), 'read', { signal }); }
    catch (error) { if (error instanceof SessionPersistenceNotFoundError) { warnings.push(`会话 ${id} 尚无持久记录，已跳过`); continue; } throw error; }
    const relativePath = `sessions/${result.sessions.length}.json`; let target: FileHandle | undefined;
    try {
      const destination = await open(resolve(root, relativePath), 'wx', 0o600); target = destination;
      const header = materializeCreateHeader(source.header); assertStoredId(SessionId(id), header); assertVersion(header);
      let size = 0; let first = true;
      const put = async (text: string): Promise<void> => { const bytes = Buffer.from(text, 'utf8'); size += bytes.length; if (size > MAX_SESSION_TRANSFER_BYTES) fail(`会话 ${id} 超过256 MiB，无法完整导出；未截断任何日志`); await writeBytes(destination, bytes, signal); };
      await put(`{"header":${JSON.stringify(header)},"inheritedEventCount":${source.inheritedEventCount},"events":[`);
      const eventCount = await readChunks(source, signal, async batch => {
        const materialized = materializeAppendBatch(batch);
        for (const event of materialized) { await put(`${first ? '' : ','}${JSON.stringify(event)}`); first = false; }
        for (const ref of refsIn(materialized)) {
          const key = refKey(ref); const old = refs.get(key);
          if (old && !isDeepStrictEqual(coreRef(old), coreRef(ref))) fail('不同会话中的同一附件引用不一致');
          if (!old) refs.set(key, ref);
        }
      });
      if (!integer(source.inheritedEventCount) || source.inheritedEventCount > eventCount) fail(`会话 ${id} 的继承前缀不完整`);
      await put(']}'); await destination.sync();
      result.sessions.push({ id, path: relativePath, header, inheritedEventCount: source.inheritedEventCount, eventCount });
    } finally { try { await target?.close(); } finally { await source.close(); } }
  }
  const payloads = new Map<string, { path: string; bytes: number }>();
  for (const entry of refs.values()) {
    signal.throwIfAborted(); const knownPath = payloads.get(entry.ref.attachmentId);
    if (knownPath) { if (knownPath.bytes !== entry.ref.bytes) fail('同一附件标识的字节数不一致'); result.attachments.push({ ...entry, path: knownPath.path }); continue; }
    const relativePath = `attachments/${payloads.size}.bin`; const target = await open(resolve(root, relativePath), 'wx', 0o600);
    const digest = createHash('sha256'); let bytes = 0;
    try {
      const put = async (chunk: Uint8Array): Promise<void> => { bytes += chunk.length; if (bytes > entry.ref.bytes || bytes > MAX_ATTACHMENT_BYTES) fail('附件字节数超出记录，未截断保存'); digest.update(chunk); await writeBytes(target, chunk, signal); };
      if (entry.kind === 'image') {
        const stored = await ctx.attachments.readImage(entry.ref, signal);
        if (!isDeepStrictEqual(coreRef(entry), coreRef({ kind: 'image', ref: stored.ref, path: '' }))) fail('原生图片读取结果与会话引用不一致');
        await put(stored.data);
      } else for await (const chunk of ctx.attachments.readFileStream(entry.ref, signal)) await put(chunk);
      const checksum = digest.digest('hex');
      if (bytes !== entry.ref.bytes || (entry.kind === 'file' && checksum !== fileDigest(entry.ref))) fail('原生附件校验失败');
      await target.sync(); payloads.set(entry.ref.attachmentId, { path: relativePath, bytes }); result.attachments.push({ ...entry, path: relativePath });
    } finally { await target.close(); }
  }
  return result;
}

async function archiveFile(root: string, name: string, prefix: 'sessions' | 'attachments'): Promise<string> {
  if (typeof name !== 'string' || !name.startsWith(`${prefix}/`) || name.includes('\\') || name.includes('\0') || posix.isAbsolute(name) || win32.isAbsolute(name) || name.split('/').some(part => !part || part === '.' || part === '..')) fail('归档中的相对路径无效');
  const base = await realpath(root); let cursor = base;
  for (const part of name.split('/')) { cursor = resolve(cursor, part); if ((await lstat(cursor)).isSymbolicLink()) fail('归档内容不能是符号链接'); }
  const value = await realpath(cursor); const rel = relative(base, value);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel) || !(await stat(value)).isFile()) fail('归档文件越过备份目录');
  return value;
}

async function readDocument(file: string, signal: AbortSignal): Promise<{ document: SessionDocument; sha256: string }> {
  signal.throwIfAborted(); const info = await stat(file);
  if (!info.isFile() || info.size > MAX_SESSION_TRANSFER_BYTES) fail('单个会话文件超过256 MiB，不能完整校验');
  const bytes = await readFile(file, { signal }); if (bytes.length > MAX_SESSION_TRANSFER_BYTES) fail('会话文件在读取时超过256 MiB');
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return fail('会话文件不是完整的UTF-8 JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('会话文件格式无效');
  const value = parsed as SessionDocument;
  if (!value.header || !Array.isArray(value.events) || !integer(value.inheritedEventCount)) fail('会话快照缺少完整的头、日志或继承信息');
  return { document: value, sha256: hash(bytes) };
}

function validateDocument(ctx: Context, entry: SessionTransferEntry, document: SessionDocument, cwdRoot: string): SessionHeader {
  if (!validId(entry.id) || !integer(entry.inheritedEventCount) || !integer(entry.eventCount) || document.events.length !== entry.eventCount || document.inheritedEventCount !== entry.inheritedEventCount || !isDeepStrictEqual(document.header, entry.header)) fail('会话文件与备份目录描述不一致');
  const source = materializeCreateHeader(document.header); assertStoredId(SessionId(entry.id), source); assertVersion(source);
  if (source.cwd !== undefined && (typeof source.cwd !== 'string' || (!posix.isAbsolute(source.cwd) && !win32.isAbsolute(source.cwd)))) fail('原会话工作目录不是绝对路径');
  const mapped = { ...source, cwd: mappedWorkspace(cwdRoot, source.cwd) };
  validateStoredEvents(mapped, document.events);
  // A detached verifier may append a local end-seed marker. Its log is never
  // exported or persisted; document.events stays the original complete prefix.
  const scratch = Session.create(SessionId(entry.id), document.events, mapped, SessionLogOffset(document.inheritedEventCount), ctx.sessions.messageProjections);
  return scratch.header;
}

async function digestFile(file: string, signal: AbortSignal): Promise<{ digest: string; bytes: number }> {
  const digest = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(file, { signal, highWaterMark: 64 * 1024 })) { signal.throwIfAborted(); bytes += chunk.length; if (bytes > MAX_ATTACHMENT_BYTES) fail('附件超过2 GiB'); digest.update(chunk); }
  return { digest: digest.digest('hex'), bytes };
}

/** Full validation is read-only; workspace directories and native objects are not created. */
export async function validateSessionTransfer(ctx: Context, root: string, sessions: readonly SessionTransferEntry[], attachments: readonly AttachmentTransferEntry[], cwdRoot: string, signal: AbortSignal, options: { resume?: boolean } = {}): Promise<ValidatedSessionTransfer> {
  mappedWorkspace(cwdRoot); const selected = new Set<string>(); const required = new Map<string, AttachmentTransferEntry>();
  const validated: ValidatedSessionEntry[] = []; const conflicts: string[] = [];
  for (const entry of sessions) {
    signal.throwIfAborted(); if (selected.has(entry.id)) fail('备份中出现重复会话标识'); selected.add(entry.id);
    const sourceFile = await archiveFile(root, entry.path, 'sessions'); const { document, sha256 } = await readDocument(sourceFile, signal);
    const header = validateDocument(ctx, entry, document, cwdRoot);
    for (const ref of refsIn(document.events)) { const key = refKey(ref); const old = required.get(key); if (old && !isDeepStrictEqual(coreRef(old), coreRef(ref))) fail('会话中的附件引用不一致'); if (!old) required.set(key, ref); }
    const ready = Object.freeze({ ...entry, header, sourceHeader: materializeCreateHeader(document.header), sourceFile, sha256 });
    const live = ctx.sessions.get(SessionId(entry.id)); const existing = await ctx.sessionPersistence.stat(SessionId(entry.id), { signal });
    if (live || existing) {
      if (options.resume && !live && existing) {
        try { await assertPrefix(ctx, ready, document.events, signal); }
        catch (error) { signal.throwIfAborted(); conflicts.push(error instanceof Error ? error.message : `已有会话 ${entry.id} 不符合中断恢复条件`); }
      } else conflicts.push(live ? `会话 ${entry.id} 仍在运行` : `会话 ${entry.id} 已存在`);
    }
    validated.push(ready);
  }
  const parents = new Map(validated.map(entry => [entry.id, entry.header.parentSession]));
  for (const entry of validated) {
    const seen = new Set<string>(); let cursor: string | undefined = entry.id;
    while (cursor && parents.has(cursor)) { if (seen.has(cursor)) fail('会话派生关系出现循环，不能恢复'); seen.add(cursor); cursor = parents.get(cursor); }
  }
  const validatedAttachments: ValidatedAttachmentEntry[] = []; const covered = new Set<string>();
  for (const entry of attachments) {
    signal.throwIfAborted(); validateRef(entry); const key = refKey(entry); const expected = required.get(key);
    if (covered.has(key) || !expected || !isDeepStrictEqual(coreRef(expected), coreRef(entry))) fail('备份附件不是选中会话中的明确原生引用'); covered.add(key);
    const sourceFile = await archiveFile(root, entry.path, 'attachments'); const value = await digestFile(sourceFile, signal);
    if (value.bytes !== entry.ref.bytes || (entry.kind === 'file' && value.digest !== fileDigest(entry.ref))) fail('备份附件字节数或内容标识不匹配');
    if (entry.kind === 'image') { const data = await readFile(sourceFile, { signal }); await ctx.attachments.validateImage({ data, mediaType: entry.ref.mediaType, name: entry.ref.name }); signal.throwIfAborted(); }
    validatedAttachments.push(Object.freeze({ ...entry, ref: structuredClone(entry.ref), sourceFile, sha256: value.digest }) as ValidatedAttachmentEntry);
  }
  if (covered.size !== required.size) fail('完整会话引用的附件没有全部包含在备份中');
  const plan: ValidatedSessionTransfer = Object.freeze({ sessions: Object.freeze(validated), attachments: Object.freeze(validatedAttachments), warnings: Object.freeze([] as string[]), conflicts: Object.freeze(conflicts), cwdRoot: resolve(cwdRoot) });
  validatedPlans.add(plan); return plan;
}

async function planEvents(ctx: Context, entry: ValidatedSessionEntry, cwdRoot: string, signal: AbortSignal): Promise<readonly SessionEvent[]> {
  const value = await readDocument(entry.sourceFile, signal); if (value.sha256 !== entry.sha256) fail('校验后会话文件发生了变化，请重新校验');
  const header = validateDocument(ctx, { ...entry, header: entry.sourceHeader }, value.document, cwdRoot);
  if (!isDeepStrictEqual(header, entry.header)) fail('校验后的工作目录映射发生变化');
  return value.document.events;
}

async function assertPrefix(ctx: Context, entry: ValidatedSessionEntry, events: readonly SessionEvent[], signal: AbortSignal): Promise<number> {
  const existing = await ctx.sessionPersistence.open(SessionId(entry.id), 'read', { signal });
  try {
    if (!isDeepStrictEqual(existing.header, entry.header) || existing.inheritedEventCount !== entry.inheritedEventCount) fail(`已有会话 ${entry.id} 的头与待恢复内容不一致`);
    return await readChunks(existing, signal, async batch => { for (const event of batch) if (event.seq >= events.length || !isDeepStrictEqual(event, events[event.seq])) fail(`已有会话 ${entry.id} 不是待恢复日志的精确前缀`); });
  } finally { await existing.close(); }
}

/** Writes only native attachments and persistence handles; it never resolves or starts an Agent. */
export async function restoreSessions(ctx: Context, plan: ValidatedSessionTransfer, signal: AbortSignal, options: { resume: boolean } = { resume: false }): Promise<{ sessions: number; attachments: number; warnings: string[] }> {
  if (!validatedPlans.has(plan)) fail('恢复必须使用当前实例已经校验的计划');
  const offsets = new Map<string, number>();
  // Every conflict and attachment digest is checked before the first write.
  for (const entry of plan.sessions) {
    signal.throwIfAborted(); const events = await planEvents(ctx, entry, plan.cwdRoot, signal);
    if (ctx.sessions.get(SessionId(entry.id))) fail(`会话 ${entry.id} 仍在运行，不能覆盖或续写`);
    const stored = await ctx.sessionPersistence.stat(SessionId(entry.id), { signal });
    if (stored && !options.resume) fail(`会话 ${entry.id} 已存在，拒绝覆盖`);
    offsets.set(entry.id, stored ? await assertPrefix(ctx, entry, events, signal) : 0);
  }
  for (const entry of plan.attachments) { signal.throwIfAborted(); const value = await digestFile(entry.sourceFile, signal); if (value.digest !== entry.sha256 || value.bytes !== entry.ref.bytes) fail('校验后附件文件发生变化，请重新校验'); }
  for (const entry of plan.sessions) { signal.throwIfAborted(); await mkdir(entry.header.cwd!, { recursive: true, mode: 0o700 }); }
  for (const entry of plan.attachments) {
    signal.throwIfAborted(); let actual: AttachmentTransferEntry;
    if (entry.kind === 'image') {
      const data = await readFile(entry.sourceFile, { signal }); if (hash(data) !== entry.sha256) fail('图片文件在恢复时发生变化');
      actual = { kind: 'image', ref: await ctx.attachments.saveImage({ data, mediaType: entry.ref.mediaType, name: entry.ref.name }), path: '' };
    } else {
      const source = async function* (): AsyncIterable<Uint8Array> {
        const digest = createHash('sha256'); let bytes = 0;
        for await (const chunk of createReadStream(entry.sourceFile, { signal, highWaterMark: 64 * 1024 })) { signal.throwIfAborted(); bytes += chunk.length; if (bytes > entry.ref.bytes) fail('文件附件在恢复时变长'); digest.update(chunk); yield chunk; }
        if (bytes !== entry.ref.bytes || digest.digest('hex') !== entry.sha256) fail('文件附件在恢复时发生变化');
      };
      actual = { kind: 'file', ref: await ctx.attachments.saveFileStream({ data: source(), name: entry.ref.name, signal }), path: '' };
    }
    if (!isDeepStrictEqual(coreRef(actual), coreRef(entry))) fail('原生附件导入后标识、名称、大小或图片尺寸改变，未恢复会话日志');
  }
  for (const entry of plan.sessions) {
    signal.throwIfAborted(); const events = await planEvents(ctx, entry, plan.cwdRoot, signal);
    const stored = await ctx.sessionPersistence.stat(SessionId(entry.id), { signal });
    let handle: SessionHandle;
    if (stored) {
      if (!options.resume) fail(`会话 ${entry.id} 在恢复期间被创建，拒绝覆盖`);
      const offset = await assertPrefix(ctx, entry, events, signal); if (offset < (offsets.get(entry.id) ?? 0)) fail('已有会话日志意外回退');
      offsets.set(entry.id, offset); handle = await ctx.sessionPersistence.open(SessionId(entry.id), 'write', { signal });
    } else handle = await ctx.sessionPersistence.create(entry.header, { inheritedEventCount: SessionLogOffset(entry.inheritedEventCount), signal });
    try {
      // Recheck after the exclusive writer is acquired, closing the read/write race.
      if (!isDeepStrictEqual(handle.header, entry.header) || handle.inheritedEventCount !== entry.inheritedEventCount) fail('会话写句柄与已校验的恢复计划不一致');
      const current = await readChunks(handle, signal, async batch => { for (const event of batch) if (event.seq >= events.length || !isDeepStrictEqual(event, events[event.seq])) fail('获得写权限后发现会话前缀冲突'); });
      for (let offset = current; offset < events.length; offset += READ_BATCH) { signal.throwIfAborted(); await handle.append(events.slice(offset, offset + READ_BATCH), { signal }); }
      await handle.flush({ signal });
    } finally { await handle.close(); }
  }
  return { sessions: plan.sessions.length, attachments: plan.attachments.length, warnings: [...plan.warnings] };
}
