import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { AttachmentId, type FileAttachmentRef, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { createAssistantMessage, createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm';
import { SESSION_FORMAT_VERSION, SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence';
import { exportSessions, mappedWorkspace, MAX_SESSION_TRANSFER_BYTES, restoreSessions, validateSessionTransfer, type SessionTransferEntry } from './backup-sessions.ts';

const roots: string[] = [];
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const fileBytes = Buffer.from('complete original file bytes');
const imageRef: ImageAttachmentRef = { attachmentId: AttachmentId(`sha256:${digest(png)}`), mediaType: 'image/png', bytes: png.length, width: 1, height: 1, name: 'image.png', originalDimensions: { width: 4, height: 4 } };
const fileRef = (name = 'one.txt'): FileAttachmentRef => ({ attachmentId: AttachmentId(`sha256:${digest(fileBytes)}`), bytes: fileBytes.length, name });
const signal = (): AbortSignal => new AbortController().signal;
function header(id: string, extra: Partial<SessionHeader> = {}): SessionHeader { return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1234, cwd: '/old/shared-workspace', isSeeded: false, ...extra }; }
function events(content: ContentBlock[] = [{ type: 'text', text: '真实用户正文以及 C:\\private\\never-read.txt' }]): SessionEvent[] {
  return [
    { seq: 0, time: 10, type: 'user/message', data: createUserMessage({ source: { kind: 'user' }, content }), surfaceOp: 'append' },
    { seq: 1, time: 11, type: 'assistant/message', data: { turn: 0, step: 0, message: createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'reasoning', text: '完整保留的模型记录' }, { type: 'text', text: '真实助手正文' }] }), stream: [] }, surfaceOp: 'append' },
    { seq: 2, time: 12, type: 'plugin:fixture/opaque', data: { keep: ['full', 'opaque', 'trace'], fake: { type: 'file', attachment: { attachmentId: 'arbitrary-text-id', name: '/never/read', bytes: 1 } } }, ignorable: true },
  ] as unknown as SessionEvent[];
}
interface Stored { header: SessionHeader; inheritedEventCount: number; events: SessionEvent[] }
function fake(initial: Record<string, Stored> = {}, options: { hot?: string[]; shortReads?: number } = {}) {
  const records = new Map(Object.entries(initial).map(([id, value]) => [id, structuredClone(value)]));
  const reads: string[] = []; const writes: Array<{ kind: string; id: string; count?: number }> = []; const closed: string[] = []; const cancelled: string[] = []; const flushed: string[] = [];
  const hot = new Map((options.hot ?? []).map(id => [id, { id, header: records.get(id)!.header }]));
  const agents = new Map([...hot].map(([id, session]) => {
    const agent = { status: 'running', session, cancel: vi.fn(() => { cancelled.push(id); agent.status = 'idle'; }), whenIdle: vi.fn(async () => {}) };
    return [id, agent];
  }));
  const makeHandle = (id: string, access: 'read' | 'write') => {
    const value = records.get(id)!;
    return { id, access, header: value.header, inheritedEventCount: value.inheritedEventCount,
      read: vi.fn(async (offset = 0, length = Number.MAX_SAFE_INTEGER, readOptions?: { signal?: AbortSignal }) => { readOptions?.signal?.throwIfAborted(); reads.push(id); return { eventState: 'detached', events: structuredClone(value.events.slice(offset, offset + Math.min(length, options.shortReads ?? length))) }; }),
      append: vi.fn(async (batch: SessionEvent[], writeOptions?: { signal?: AbortSignal }) => { writeOptions?.signal?.throwIfAborted(); expect(access).toBe('write'); expect(batch[0]?.seq).toBe(value.events.length); value.events.push(...structuredClone(batch)); writes.push({ kind: 'append', id, count: batch.length }); }),
      flush: vi.fn(async () => { writes.push({ kind: 'flush', id }); }), close: vi.fn(async () => { closed.push(id); }),
    };
  };
  const persistence = {
    list: vi.fn(async (value?: { signal?: AbortSignal }) => { value?.signal?.throwIfAborted(); return [...records.values()].map(value => ({ header: value.header, revision: 'fixture', eventCount: value.events.length })); }),
    stat: vi.fn(async (id: string, value?: { signal?: AbortSignal }) => { value?.signal?.throwIfAborted(); const stored = records.get(id); return stored ? { header: stored.header, revision: 'fixture', eventCount: stored.events.length } : undefined; }),
    open: vi.fn(async (id: string, access: 'read' | 'write', value?: { signal?: AbortSignal }) => { value?.signal?.throwIfAborted(); if (!records.has(id)) throw new SessionPersistenceNotFoundError(SessionId(id)); return makeHandle(id, access); }),
    create: vi.fn(async (value: SessionHeader, createOptions?: { signal?: AbortSignal; inheritedEventCount?: number }) => { createOptions?.signal?.throwIfAborted(); if (records.has(value.id)) throw new Error('already exists'); records.set(value.id, { header: structuredClone(value), inheritedEventCount: createOptions?.inheritedEventCount ?? 0, events: [] }); writes.push({ kind: 'create', id: value.id }); return makeHandle(value.id, 'write'); }),
  };
  const savedImages: ImageAttachmentRef[] = []; const savedFiles: FileAttachmentRef[] = [];
  const attachments = {
    readImage: vi.fn(async (ref: ImageAttachmentRef, requestSignal?: AbortSignal) => { requestSignal?.throwIfAborted(); return { ref, data: png }; }),
    readFileStream: vi.fn(async function* (_ref: FileAttachmentRef, requestSignal?: AbortSignal) { requestSignal?.throwIfAborted(); yield fileBytes.subarray(0, 5); yield fileBytes.subarray(5); }),
    validateImage: vi.fn(async (value: { data: Uint8Array }) => { if (digest(value.data) !== digest(png)) throw new Error('invalid image bytes'); }),
    saveImage: vi.fn(async (value: { data: Uint8Array; name?: string }) => { const saved = { attachmentId: AttachmentId(`sha256:${digest(value.data)}`), bytes: value.data.length, width: 1, height: 1, mediaType: 'image/png' as const, ...(value.name ? { name: value.name } : {}) }; savedImages.push(saved); return saved; }),
    saveFileStream: vi.fn(async (value: { data: AsyncIterable<Uint8Array>; signal?: AbortSignal; name: string }) => { const chunks: Uint8Array[] = []; for await (const chunk of value.data) { value.signal?.throwIfAborted(); chunks.push(chunk); } const bytes = Buffer.concat(chunks); const saved = { attachmentId: AttachmentId(`sha256:${digest(bytes)}`), name: value.name, bytes: bytes.length }; savedFiles.push(saved); return saved; }),
  };
  const ctx = { sessionPersistence: persistence, agents: { get: (id: string) => agents.get(id) }, sessions: { messageProjections: [], list: () => [...hot.values()], get: (id: string) => hot.get(id), flush: async (session: { id: string }) => { expect(agents.get(session.id)?.status).toBe('idle'); flushed.push(session.id); return true; } }, attachments } as unknown as Context;
  return { ctx, records, reads, writes, closed, cancelled, flushed, persistence, attachments, savedImages, savedFiles };
}
async function fixture(withAttachments = false) {
  const base = await realpath(tmpdir()); const root = await mkdtemp(join(base, 'zeta-session-transfer-')); roots.push(root);
  const stage = join(root, 'stage'); const workspace = join(root, 'new-workspaces'); await mkdir(stage);
  const content: ContentBlock[] = [{ type: 'text', text: '不把历史文本里的 /etc/private-key 当作附件读取' }];
  if (withAttachments) content.push({ type: 'image', attachment: imageRef }, { type: 'file', attachment: fileRef() }, { type: 'file', attachment: fileRef('two.txt') });
  const original = events(content); const source = fake({ root: { header: header('root'), inheritedEventCount: 0, events: original } });
  const exported = await exportSessions(source.ctx, ['root'], stage, signal());
  return { root, stage, workspace, original, source, exported };
}
afterEach(async () => {
  const base = await realpath(tmpdir());
  for (const root of roots.splice(0)) { const rel = relative(base, await realpath(root)); if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Unsafe test cleanup'); await rm(root, { recursive: true, force: true }); }
});

describe('native full-session backup transfer', () => {
  it('exports only roots and descendants, stops and flushes their hot Agents, and never repairs the raw log', async () => {
    const f = await fixture();
    const childHeader = header('child', { parentSession: SessionId('root'), isSeeded: true, origin: 'subagent', delegationDepth: 1 });
    const childEvents = [f.original[0]!, { type: 'session/end-seed', seq: 1, time: 11, data: { inherited: true } }] as SessionEvent[];
    const source = fake({ root: { header: header('root'), inheritedEventCount: 0, events: f.original }, child: { header: childHeader, inheritedEventCount: 1, events: childEvents }, unrelated: { header: header('unrelated'), inheritedEventCount: 0, events: events() } }, { hot: ['root', 'child', 'unrelated'], shortReads: 1 });
    const nextStage = join(f.root, 'second-stage'); await mkdir(nextStage);
    const exported = await exportSessions(source.ctx, ['root', 'reserved'], nextStage, signal());
    expect(exported.sessions.map(value => value.id)).toEqual(['root', 'child']); expect(exported.warnings.join()).toContain('reserved');
    expect(source.cancelled.toSorted()).toEqual(['child', 'root']); expect(source.flushed.toSorted()).toEqual(['child', 'root']); expect(source.reads).not.toContain('unrelated');
    const body = JSON.parse(await readFile(join(nextStage, exported.sessions[0]!.path), 'utf8'));
    expect(body.events).toEqual(f.original); expect(body.events).toHaveLength(3); expect(body.events.some((event: { type: string }) => event.type === 'session/end-seed')).toBe(false);
    const target = fake(); const plan = await validateSessionTransfer(target.ctx, nextStage, exported.sessions, exported.attachments, f.workspace, signal());
    await restoreSessions(target.ctx, plan, signal(), { resume: false });
    expect(target.records.get('child')).toMatchObject({ header: { parentSession: 'root', isSeeded: true, origin: 'subagent', delegationDepth: 1 }, inheritedEventCount: 1, events: childEvents });
  });

  it('validates without writes and restores complete raw events, stable IDs, times, lineage and shared mapped cwd', async () => {
    const f = await fixture(true); const target = fake();
    const plan = await validateSessionTransfer(target.ctx, f.stage, f.exported.sessions, f.exported.attachments, f.workspace, signal());
    expect(target.writes).toEqual([]); expect(target.savedImages).toEqual([]); expect(target.savedFiles).toEqual([]); await expect(stat(f.workspace)).rejects.toThrow();
    expect(plan.sessions[0]!.sourceHeader.cwd).toBe('/old/shared-workspace'); expect(plan.sessions[0]!.header.cwd).toBe(mappedWorkspace(f.workspace, '/old/shared-workspace'));
    expect(mappedWorkspace(f.workspace, '/old/shared-workspace')).toBe(mappedWorkspace(f.workspace, '/old/shared-workspace'));
    expect(f.exported.attachments).toHaveLength(3); expect(f.exported.attachments[1]!.path).toBe(f.exported.attachments[2]!.path); expect(f.source.attachments.readFileStream).toHaveBeenCalledTimes(1);
    const result = await restoreSessions(target.ctx, plan, signal(), { resume: false });
    expect(result).toMatchObject({ sessions: 1, attachments: 3 }); expect(target.records.get('root')!.events).toEqual(f.original);
    expect(target.records.get('root')!.header).toMatchObject({ id: 'root', createdAt: 1234, isSeeded: false });
    expect(target.savedFiles.map(value => value.name)).toEqual(['one.txt', 'two.txt']); expect(target.savedFiles.every(value => value.attachmentId === fileRef().attachmentId)).toBe(true);
    expect(target.records.get('root')!.events[0]!.data).toEqual(f.original[0]!.data); expect(target.savedImages[0]).not.toHaveProperty('originalDimensions');
    expect((JSON.parse(await readFile(join(f.stage, f.exported.sessions[0]!.path), 'utf8')) as { header: SessionHeader }).header.cwd).toBe('/old/shared-workspace');
  });

  it('refuses conflicts before attachments or sessions are written, and resume accepts only exact stored prefixes', async () => {
    const f = await fixture(true); const target = fake(); const plan = await validateSessionTransfer(target.ctx, f.stage, f.exported.sessions, f.exported.attachments, f.workspace, signal());
    target.records.set('root', { header: structuredClone(plan.sessions[0]!.header), inheritedEventCount: 0, events: structuredClone(f.original.slice(0, 1)) });
    await expect(restoreSessions(target.ctx, plan, signal(), { resume: false })).rejects.toThrow('拒绝覆盖'); expect(target.savedFiles).toEqual([]); expect(target.writes).toEqual([]);
    await restoreSessions(target.ctx, plan, signal(), { resume: true }); expect(target.records.get('root')!.events).toEqual(f.original);
    const appendCount = target.writes.filter(value => value.kind === 'append').length; await restoreSessions(target.ctx, plan, signal(), { resume: true }); expect(target.writes.filter(value => value.kind === 'append')).toHaveLength(appendCount);
    target.records.get('root')!.events[0] = { ...target.records.get('root')!.events[0]!, time: 999 };
    const savedCount = target.savedFiles.length; await expect(restoreSessions(target.ctx, plan, signal(), { resume: true })).rejects.toThrow('精确前缀'); expect(target.savedFiles).toHaveLength(savedCount);
  });

  it('revalidates a journal-authorized interrupted restore without treating an exact prefix as a conflict', async () => {
    const f = await fixture(); const full = [...f.original, ...Array.from({ length: 300 }, (_, index) => ({ type: 'plugin:fixture/item', seq: index + 3, time: index + 20, data: { index }, ignorable: true }))] as unknown as SessionEvent[];
    const source = fake({ root: { header: header('root'), inheritedEventCount: 0, events: full } }); const stage = join(f.root, 'interrupted-stage'); await mkdir(stage);
    const exported = await exportSessions(source.ctx, ['root'], stage, signal()); const target = fake();
    const initial = await validateSessionTransfer(target.ctx, stage, exported.sessions, [], f.workspace, signal());
    const create = target.persistence.create.getMockImplementation()!;
    target.persistence.create.mockImplementationOnce(async (...args) => {
      const handle = await create(...args); const append = handle.append; let count = 0;
      handle.append = vi.fn(async (...values) => { if (count++ === 1) throw new Error('simulated interruption'); return append(...values); });
      return handle;
    });
    await expect(restoreSessions(target.ctx, initial, signal(), { resume: false })).rejects.toThrow('simulated interruption'); expect(target.records.get('root')!.events).toHaveLength(128);
    const before = target.writes.length;
    const ordinary = await validateSessionTransfer(target.ctx, stage, exported.sessions, [], f.workspace, signal()); expect(ordinary.conflicts).toHaveLength(1);
    const resumed = await validateSessionTransfer(target.ctx, stage, exported.sessions, [], f.workspace, signal(), { resume: true }); expect(resumed.conflicts).toEqual([]); expect(target.writes).toHaveLength(before);
    target.records.get('root')!.events[0] = { ...target.records.get('root')!.events[0]!, time: 999 };
    const tampered = await validateSessionTransfer(target.ctx, stage, exported.sessions, [], f.workspace, signal(), { resume: true }); expect(tampered.conflicts.join()).toContain('精确前缀'); expect(target.writes).toHaveLength(before);
    target.records.get('root')!.events[0] = structuredClone(full[0]!);
    const ready = await validateSessionTransfer(target.ctx, stage, exported.sessions, [], f.workspace, signal(), { resume: true }); await restoreSessions(target.ctx, ready, signal(), { resume: true }); expect(target.records.get('root')!.events).toEqual(full);
  });

  it('rejects missing attachment payloads and corrupt file bytes without publishing native objects', async () => {
    const f = await fixture(true); const target = fake();
    await expect(validateSessionTransfer(target.ctx, f.stage, f.exported.sessions, [], f.workspace, signal())).rejects.toThrow('没有全部包含');
    const file = f.exported.attachments.find(value => value.kind === 'file')!; await writeFile(join(f.stage, file.path), Buffer.alloc(file.ref.bytes, 1));
    await expect(validateSessionTransfer(target.ctx, f.stage, f.exported.sessions, f.exported.attachments, f.workspace, signal())).rejects.toThrow('不匹配'); expect(target.writes).toEqual([]); expect(target.savedFiles).toEqual([]);
  });

  it('refuses changed staged files after validation and a native image store that changes core IDs or dimensions', async () => {
    const f = await fixture(true); const target = fake(); const plan = await validateSessionTransfer(target.ctx, f.stage, f.exported.sessions, f.exported.attachments, f.workspace, signal());
    const sessionFile = join(f.stage, f.exported.sessions[0]!.path); const before = await readFile(sessionFile); await writeFile(sessionFile, Buffer.concat([before, Buffer.from(' ')]));
    await expect(restoreSessions(target.ctx, plan, signal(), { resume: false })).rejects.toThrow('发生了变化'); expect(target.savedFiles).toEqual([]); expect(target.writes).toEqual([]);
    await writeFile(sessionFile, before); target.attachments.saveImage.mockImplementationOnce(async value => ({ attachmentId: imageRef.attachmentId, mediaType: 'image/png', bytes: value.data.length, width: 2, height: 1 }));
    await expect(restoreSessions(target.ctx, plan, signal(), { resume: false })).rejects.toThrow('尺寸改变'); expect(target.writes).toEqual([]);
  });

  it('rejects unsupported event formats, invalid contiguity, and archive traversal before native writes', async () => {
    const f = await fixture(); const target = fake(); const row = f.exported.sessions[0]!;
    await expect(validateSessionTransfer(target.ctx, f.stage, [{ ...row, path: '../outside.json' }], [], f.workspace, signal())).rejects.toThrow('相对路径');
    const raw = JSON.parse(await readFile(join(f.stage, row.path), 'utf8')); raw.events[0].seq = 4; await writeFile(join(f.stage, row.path), JSON.stringify(raw));
    await expect(validateSessionTransfer(target.ctx, f.stage, [row], [], f.workspace, signal())).rejects.toThrow();
    raw.events[0].seq = 0; raw.events[2].ignorable = false; await writeFile(join(f.stage, row.path), JSON.stringify(raw));
    await expect(validateSessionTransfer(target.ctx, f.stage, [row], [], f.workspace, signal())).rejects.toThrow('unknown'); expect(target.writes).toEqual([]);
  });

  it('does not truncate oversized session files, and honours cancellation before I/O', async () => {
    const f = await fixture(); const target = fake(); const file = await open(join(f.stage, f.exported.sessions[0]!.path), 'r+');
    try { await file.truncate(MAX_SESSION_TRANSFER_BYTES + 1); } finally { await file.close(); }
    await expect(validateSessionTransfer(target.ctx, f.stage, f.exported.sessions, [], f.workspace, signal())).rejects.toThrow('256 MiB'); expect(target.writes).toEqual([]);
    const controller = new AbortController(); controller.abort(new Error('cancel fixture'));
    await expect(exportSessions(target.ctx, ['root'], f.stage, controller.signal)).rejects.toThrow('cancel fixture');
    await expect(validateSessionTransfer(target.ctx, f.stage, f.exported.sessions, [], f.workspace, controller.signal)).rejects.toThrow('cancel fixture');
  });

  it('refuses lossy non-JSON events and unsigned validation plans', async () => {
    const f = await fixture(); const bad = fake({ bad: { header: header('bad'), inheritedEventCount: 0, events: [{ type: 'plugin:fixture/bigint', seq: 0, time: 1, data: { bigint: 2n }, ignorable: true }] as unknown as SessionEvent[] } });
    const destination = join(f.root, 'bad-stage'); await mkdir(destination);
    await expect(exportSessions(bad.ctx, ['bad'], destination, signal())).rejects.toThrow('losslessly'); expect(bad.closed).toEqual(['bad']);
    await expect(restoreSessions(fake().ctx, {} as never, signal(), { resume: false })).rejects.toThrow('已经校验');
  });
});
