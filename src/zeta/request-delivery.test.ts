import type { Context } from '@deepseek-ai/cordis';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZetaRuntime } from './runtime.ts';
import { spaceDirectory, ZetaState } from './state.ts';
import { testDomainContext } from './test-support.ts';

const readControl = vi.hoisted(() => ({ afterRead: undefined as ((path: unknown) => void) | undefined }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    const value = await actual.readFile(...args);
    readControl.afterRead?.(args[0]);
    return value;
  } };
});

interface Execution { agent: unknown; name: string; callId?: string; arguments?: unknown; signal?: AbortSignal }
type Guard = (exec: Execution) => string | undefined;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  readControl.afterRead = undefined;
  for (const close of cleanup.splice(0).reverse()) await close();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zeta-request-delivery-'));
  cleanup.push(async () => {
    const path = relative(tmpdir(), root);
    if (!path || isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) throw new Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true });
  });
  let guard!: Guard;
  const listeners = new Map<string, (exec: Execution, next: () => Promise<unknown>) => Promise<unknown>>();
  const ctx = Object.assign(testDomainContext(), {
    tools: { register: () => () => {}, guard: (value: Guard) => { guard = value; return () => {}; } },
    on: (event: string, listener: (exec: Execution, next: () => Promise<unknown>) => Promise<unknown>) => { listeners.set(event, listener); return () => { listeners.delete(event); }; },
    effect: (execute: () => () => void) => { const stop = execute(); cleanup.push(async () => { stop(); }); return stop; },
    systemPrompt: { section: () => {}, context: () => {} },
  }) as unknown as Context;
  const state = await ZetaState.open(ctx); cleanup.push(() => state.close());
  const agent = { id: 'origin-session', session: { id: 'origin-session' } };
  await state.bind({ key: 'qq:bot:c2c:member', appId: 'bot', scope: 'c2c', peerId: 'member', sessionId: agent.id });
  for (const peerId of ['room-a', 'room-b']) await state.bind({ key: `qq:bot:group:${peerId}`, appId: 'bot', scope: 'group', peerId, sessionId: `session-${peerId}` });
  const runtime = new ZetaRuntime(ctx, state, 'bot', join(root, 'data')); runtime.install();
  const sendMarkdown = vi.fn(async () => ({ id: 'confirmed-text-receipt' }));
  const sendVoice = vi.fn(async () => ({ upload: { file_uuid: 'uploaded-voice' }, message: { id: 'confirmed-media-receipt' } }));
  const sendImage = vi.fn(async () => ({ upload: { file_uuid: 'uploaded-image' }, message: { id: 'confirmed-image-receipt' } }));
  const sendFile = vi.fn(async () => ({ upload: { file_uuid: 'uploaded-file' }, message: { id: 'confirmed-file-receipt' } }));
  runtime.attachGateway({ manager: { findByAgent: () => undefined } as never, sender: { sendMarkdown } as never,
    mediaSender: { sendVoice, sendImage, sendFile, sendVideo: sendFile } });
  const directory = await runtime.directoryFor(agent, 'speech');
  const audio = join(directory, 'first.wav'), identicalAudio = join(directory, 'different-name.wav');
  const bytes = Buffer.from('RIFF fixture identical WAV bytes');
  await writeFile(audio, bytes); await writeFile(identicalAudio, bytes);
  const newRequest = (messageId: string, signal?: AbortSignal) => runtime.beginRequest(agent, [{ senderId: 'member', messageId, text: '请把这段语音发到指定群' }], false, signal);
  const handle = newRequest('message-one');
  const signal = () => new AbortController().signal;
  const invoke = <T>(name: string, callId: string, run: () => Promise<T>) => listeners.get('tools/execute')!({ agent, name, callId }, run) as Promise<T>;
  const check = (name: string, args?: unknown, toolSignal?: AbortSignal) => guard({ agent, name, arguments: args, signal: toolSignal });
  return { root, runtime, state, agent, audio, identicalAudio, handle, newRequest, signal, invoke, check, sendMarkdown, sendVoice, sendImage, sendFile };
}

describe('request-scoped QQ delivery and long-operation feedback', () => {
  it('rejects a missing media target before any SDK send', async () => {
    const f = await fixture();
    expect(() => f.runtime.validateSendTarget(f.agent, undefined, 'speech')).toThrow(/target|目标/);
    await expect(Promise.resolve().then(() => f.runtime.sendFile(f.agent, f.audio, undefined, f.signal()))).rejects.toThrow(/target|目标/);
    expect(f.sendVoice).not.toHaveBeenCalled(); expect(f.sendImage).not.toHaveBeenCalled(); expect(f.sendFile).not.toHaveBeenCalled();
  });

  it('delivers identical audio only once per message and target across tool calls and file names', async () => {
    const f = await fixture();
    const first = await f.invoke('zeta_speech_generate', 'generation-call', () => f.runtime.sendFile(f.agent, f.audio, 'group:room-a', f.signal()));
    expect(await f.runtime.hasDeliveredFile(f.agent, f.audio)).toBe(true);
    expect(await f.runtime.hasDeliveredFile(f.agent, f.identicalAudio)).toBe(true);
    const repeated = await f.invoke('qqbot_send_file', 'different-file-call', () => f.runtime.sendFile(f.agent, f.identicalAudio, 'group:room-a', f.signal()));
    expect(first).toMatchObject({ status: 'accepted', target: 'group:room-a' });
    expect(repeated).toMatchObject({ reused: true, target: 'group:room-a' });
    const key = f.runtime.requestKeyFor(f.agent);
    f.runtime.endRequest(f.agent, f.handle); f.newRequest('message-one');
    expect(f.runtime.requestKeyFor(f.agent)).toBe(key);
    expect(await f.invoke('qqbot_send_file', 'redelivered-message-call', () => f.runtime.sendFile(f.agent, f.audio, 'group:room-a', f.signal()))).toMatchObject({ reused: true });
    expect(f.sendVoice).toHaveBeenCalledTimes(1);
    expect(f.sendVoice.mock.calls[0]?.[0]).toEqual({ scope: 'group', targetId: 'room-a' });
  });

  it('allows one delivery to each explicit target and a new delivery for a new user message', async () => {
    const f = await fixture();
    await f.invoke('zeta_speech_generate', 'a', () => f.runtime.sendFile(f.agent, f.audio, 'group:room-a', f.signal()));
    await f.invoke('qqbot_send_file', 'b', () => f.runtime.sendFile(f.agent, f.identicalAudio, 'group:room-b', f.signal()));
    f.newRequest('message-two');
    expect(await f.runtime.hasDeliveredFile(f.agent, f.audio)).toBe(false);
    await f.invoke('zeta_speech_generate', 'c', () => f.runtime.sendFile(f.agent, f.audio, 'group:room-a', f.signal()));
    expect(f.sendVoice).toHaveBeenCalledTimes(3);
    expect(f.sendVoice.mock.calls.map(call => call[0])).toEqual([
      { scope: 'group', targetId: 'room-a' }, { scope: 'group', targetId: 'room-b' }, { scope: 'group', targetId: 'room-a' },
    ]);
  });

  it('does not retry an unknown delivery under a new call ID or renamed audio', async () => {
    const f = await fixture(); f.sendVoice.mockRejectedValueOnce(new Error('connection lost after submission'));
    await expect(f.invoke('zeta_speech_generate', 'first', () => f.runtime.sendFile(f.agent, f.audio, 'group:room-a', f.signal()))).rejects.toThrow('未确认');
    await expect(f.invoke('qqbot_send_file', 'retry', () => f.runtime.sendFile(f.agent, f.identicalAudio, 'group:room-a', f.signal()))).rejects.toThrow('禁止自动重发');
    expect(f.sendVoice).toHaveBeenCalledTimes(1);
    expect(Object.values((await f.state.snapshot()).tables.effects)).toEqual([expect.objectContaining({ status: 'unknown', kind: 'speech' })]);
  });

  it('rejects an already-aborted request without submitting media', async () => {
    const f = await fixture(); const controller = new AbortController();
    f.newRequest('cancelled-request', controller.signal); controller.abort(new Error('fixture request cancelled'));
    await expect(Promise.resolve().then(() => f.runtime.sendFile(f.agent, f.audio, 'group:room-a', f.signal()))).rejects.toThrow('cancelled');
    expect(f.sendVoice).not.toHaveBeenCalled();
  });

  it('cancels media queued behind an ongoing send before its SDK operation starts', async () => {
    const f = await fixture(); const controller = new AbortController();
    f.newRequest('queued-request', controller.signal);
    const confirmation = deferred<{ id: string }>(); f.sendMarkdown.mockImplementationOnce(() => confirmation.promise);
    const acknowledgement = f.runtime.sendText(f.agent, '我先确认一下，再发送语音。', undefined, f.signal());
    await vi.waitFor(() => expect(f.sendMarkdown).toHaveBeenCalledTimes(1));
    const pending = f.runtime.sendFile(f.agent, f.audio, 'group:room-a', f.signal());
    controller.abort(new Error('fixture queued request cancelled'));
    confirmation.resolve({ id: 'already-submitted-ack' }); await acknowledgement;
    await expect(pending).rejects.toThrow('cancelled'); expect(f.sendVoice).not.toHaveBeenCalled();
  });

  it('rechecks cancellation after reading file bytes and before invoking the media SDK', async () => {
    const f = await fixture(); const controller = new AbortController();
    f.newRequest('read-cancelled-request', controller.signal);
    const read = vi.fn(); readControl.afterRead = path => { read(path); controller.abort(new Error('fixture cancelled after read')); };
    await expect(f.runtime.sendFile(f.agent, f.audio, 'group:room-a', f.signal())).rejects.toThrow('cancelled after read');
    expect(read).toHaveBeenCalledTimes(1); expect(f.sendVoice).not.toHaveBeenCalled();
    expect(Object.keys((await f.state.snapshot()).tables.effects)).toHaveLength(0);
  });

  it('keeps a late provider delivery in its original cancelled tool/request scope', async () => {
    const f = await fixture();
    const oldKey = f.runtime.requestKeyFor(f.agent), independentSignal = f.signal();
    const entered = deferred<void>(), providerFinished = deferred<void>();
    const oldRun = f.invoke('zeta_speech_generate', 'slow-provider-call', async () => {
      entered.resolve(); await providerFinished.promise;
      expect(f.runtime.requestKeyFor(f.agent)).toBe(oldKey);
      return f.runtime.sendFile(f.agent, f.audio, 'group:room-a', independentSignal);
    });
    await entered.promise;
    const nextHandle = f.newRequest('new-request-during-provider'), newKey = f.runtime.requestKeyFor(f.agent);
    expect(newKey).not.toBe(oldKey);
    expect(nextHandle).not.toBe(f.handle);
    expect(independentSignal.aborted).toBe(false);
    providerFinished.resolve();
    await expect(oldRun).rejects.toThrow();
    expect(f.sendVoice).not.toHaveBeenCalled();
    expect(f.runtime.requestKeyFor(f.agent)).toBe(newKey);
    expect(f.runtime.authorityFor(f.agent)?.sources[0]?.messageId).toBe('new-request-during-provider');
    expect(f.runtime.hasReplyDelivered(f.agent)).toBe(false);
    expect(Object.keys((await f.state.snapshot()).tables.effects)).toHaveLength(0);
  });

  it.each(['message-two', 'message-one'])('does not let an old finally revoke a new request, including repeated input %s', async messageId => {
    const f = await fixture();
    const before = f.runtime.requestKeyFor(f.agent), nextHandle = f.newRequest(messageId);
    expect(nextHandle).not.toBe(f.handle);
    if (messageId === 'message-one') expect(f.runtime.requestKeyFor(f.agent)).toBe(before);
    else expect(f.runtime.requestKeyFor(f.agent)).not.toBe(before);
    const nextKey = f.runtime.requestKeyFor(f.agent);
    f.runtime.noteAttachments(f.agent, [f.audio]);
    f.runtime.endRequest(f.agent, f.handle);
    f.runtime.noteReplyDelivered(f.agent, 'c2c:member', '迟到的旧回执', f.handle);
    expect(f.runtime.requestKeyFor(f.agent)).toBe(nextKey);
    expect(f.runtime.allowedInputFiles(f.agent)).toEqual([f.audio]);
    expect(f.runtime.hasReplyDelivered(f.agent)).toBe(false);
    await f.runtime.sendText(f.agent, '收到，这次我会发送到指定群。', undefined, f.signal());
    expect(f.runtime.hasReplyDelivered(f.agent)).toBe(true);
    await f.runtime.sendFile(f.agent, f.audio, 'group:room-a', f.signal());
    expect(f.sendVoice).toHaveBeenCalledTimes(1);
  });

  it('requires model-written confirmation and an actual origin-chat receipt before a long operation', async () => {
    const f = await fixture();
    const longTools = ['web_search', 'web_fetch', 'zeta_browser', 'zeta_speech_generate', 'zeta_image_generate', 'zeta_deploy_page'];
    for (const name of longTools) expect(f.check(name)).toContain('先用 zeta_send_message');
    await f.runtime.sendText(f.agent, '这条只发给另一个群。', 'group:room-a', f.signal());
    expect(f.runtime.hasReplyDelivered(f.agent)).toBe(false);
    for (const name of longTools) expect(f.check(name)).toBeDefined();
    const receipt = deferred<{ id: string }>(); f.sendMarkdown.mockImplementationOnce(() => receipt.promise);
    const pending = f.runtime.sendText(f.agent, '收到，我先查一下资料。', undefined, f.signal());
    await vi.waitFor(() => expect(f.sendMarkdown).toHaveBeenCalledTimes(2));
    expect(f.runtime.hasReplyDelivered(f.agent)).toBe(false); expect(f.check('web_search')).toBeDefined();
    receipt.resolve({ id: 'actual-origin-ack' }); await pending;
    expect(f.runtime.hasReplyDelivered(f.agent)).toBe(true);
    for (const name of longTools) expect(f.check(name)).toBeUndefined();
    expect(f.runtime.hasDeliveredText(f.agent, '收到，我先查一下资料。')).toBe(true);
  });

  it('does not treat a text send without a platform receipt as confirmation', async () => {
    const f = await fixture(); f.sendMarkdown.mockResolvedValueOnce({} as { id: string });
    await expect(f.runtime.sendText(f.agent, '我先帮你查一下。', undefined, f.signal())).rejects.toThrow('未确认');
    expect(f.runtime.hasReplyDelivered(f.agent)).toBe(false); expect(f.check('web_search')).toBeDefined();
  });

  it('allows native read_image only for current attachments or common pictures', async () => {
    const f = await fixture();
    const current = join(f.root, 'current.png'), other = join(f.root, 'other-chat.png');
    await writeFile(current, 'current attachment'); await writeFile(other, 'another chat attachment');
    const publicDirectory = join(f.runtime.dataDir, 'images', spaceDirectory(f.runtime.selfSpace));
    await mkdir(publicDirectory, { recursive: true }); const shared = join(publicDirectory, 'shared.png'); await writeFile(shared, 'shared image');
    f.runtime.noteAttachments(f.agent, [current]);
    expect(f.check('read_image', { file_path: current })).toBeUndefined();
    expect(f.check('read_image', { file_path: shared })).toBeUndefined();
    expect(f.check('read_image', { file_path: other })).toBeDefined();
    f.runtime.endRequest(f.agent, f.handle); f.newRequest('message-two');
    expect(f.check('read_image', { file_path: current })).toBeDefined();
    expect(f.check('read_image', { file_path: shared })).toBeUndefined();
  });
});
