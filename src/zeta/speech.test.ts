import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { ModuleExecution, ModuleHost, SpeechSettings } from './contracts.ts';
import { generateSpeech, listSpeechFiles, registerSpeechTools, sendSpeech, SPEECH_ENDPOINTS, synthesizeSpeech, validateSpeechArguments } from './speech.ts';

const roots: string[] = [];
const wave = Buffer.from('524946462400000057415645666d74201000000001000100805d000000bb0000020010006461746100000000', 'hex');
const settings = (): SpeechSettings => ({
  enabled: true, provider: 'mimo', maxTextCharacters: 1000, timeoutMs: 10000,
  mimo: { model: 'mimo-v2.5-tts', voice: 'mimo_default', speed: 1 },
  minimax: { model: 'speech-2.8-hd', voice: 'female-shaonv', speed: 1 },
});
const response = (provider: 'mimo' | 'minimax' = 'mimo'): Response => new Response(JSON.stringify(provider === 'mimo'
  ? { id: 'mimo-request', choices: [{ finish_reason: 'stop', message: { audio: { data: wave.toString('base64') } } }] }
  : { trace_id: 'minimax-request', base_resp: { status_code: 0 }, data: { status: 2, audio: wave.toString('hex') } }),
{ headers: { 'content-type': 'application/json' } });
const execution = (id = 'one', agent: unknown = { id: 'a' }): ModuleExecution => ({ agent, callId: id, signal: new AbortController().signal });

async function fixture(): Promise<{ host: ModuleHost; sent: ReturnType<typeof vi.fn>; credentials: ReturnType<typeof vi.fn> }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-zeta-speech-'));
  roots.push(root);
  const sent = vi.fn(async (_agent: unknown, _path: string, target: string) => ({ status: 'accepted', messageId: 'sent-1', target }));
  const credentials = vi.fn(async (provider: 'mimo' | 'minimax') => `${provider}-secret`);
  const host = {
    dataDir: root,
    ctx: { get: () => ({ register: vi.fn() }) },
    bindingFor(agent: unknown) {
      const id = (agent as { id?: string } | undefined)?.id;
      return id === 'a' || id === 'b' ? { key: id, appId: 'bot', scope: 'c2c' as const, peerId: id, sessionId: `session-${id}` } : undefined;
    },
    isLifeAgent: (agent: unknown) => (agent as { id?: string } | undefined)?.id === 'life',
    async directoryFor(agent: unknown) {
      const id = (agent as { id?: string } | undefined)?.id;
      if (!id || !['a', 'b', 'life'].includes(id)) throw new Error('no namespace');
      return join(root, id, 'speech');
    },
    sendFile: sent, sendText: vi.fn(), resolveApiKey: credentials,
  } as unknown as ModuleHost;
  return { host, sent, credentials };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const resolvedRoot = resolve(root);
    if (!basename(resolvedRoot).startsWith('dsh-zeta-speech-') || relative(resolve(tmpdir()), resolvedRoot).startsWith('..')) throw new Error('Unexpected cleanup target');
    await rm(resolvedRoot, { recursive: true, force: true });
  }
});

describe('speech provider protocols', () => {
  it('submits one MiMo request and decodes its base64 WAV response', async () => {
    const requestFetch = vi.fn<typeof fetch>(async () => response());
    const result = await synthesizeSpeech({ provider: 'mimo', apiKey: 'mimo-secret', text: '你好', model: 'mimo-v2.5-tts', voice: '冰糖', speed: 1.2, timeoutMs: 10000 }, new AbortController().signal, requestFetch);
    expect(result.audio).toEqual(wave);
    expect(result.providerRequestId).toBe('mimo-request');
    expect(requestFetch).toHaveBeenCalledTimes(1);
    const [url, init] = requestFetch.mock.calls[0]!;
    expect(url).toBe(SPEECH_ENDPOINTS.mimo);
    expect(init?.headers).toMatchObject({ 'api-key': 'mimo-secret' });
    const body = JSON.parse(init?.body as string);
    expect(body.messages).toEqual([{ role: 'user', content: expect.stringContaining('1.2') }, { role: 'assistant', content: '你好' }]);
    expect(body.audio).toEqual({ voice: '冰糖', format: 'wav' });
    expect(JSON.stringify(result)).not.toContain('mimo-secret');
  });

  it('submits MiniMax native voice parameters and decodes hex audio', async () => {
    const requestFetch = vi.fn<typeof fetch>(async () => response('minimax'));
    const result = await synthesizeSpeech({ provider: 'minimax', apiKey: 'minimax-secret', text: '你好', model: 'speech-2.8-hd', voice: 'female-shaonv', speed: 0.8, emotion: 'happy', timeoutMs: 10000 }, new AbortController().signal, requestFetch);
    expect(result.audio).toEqual(wave);
    const [url, init] = requestFetch.mock.calls[0]!;
    expect(url).toBe(SPEECH_ENDPOINTS.minimax);
    expect(init?.headers).toMatchObject({ authorization: 'Bearer minimax-secret' });
    expect(JSON.parse(init?.body as string)).toMatchObject({ voice_setting: { speed: 0.8, emotion: 'happy', voice_id: 'female-shaonv' }, output_format: 'hex', audio_setting: { format: 'wav' } });
  });

  it('rejects upstream service errors without leaking its message', async () => {
    const requestFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'leaked-secret raw user text' } })));
    await expect(synthesizeSpeech({ provider: 'minimax', apiKey: 'secret', text: '你好', model: 'speech-2.8-hd', voice: 'voice', speed: 1, timeoutMs: 10000 }, new AbortController().signal, requestFetch)).rejects.toThrow('服务码 1004');
    await expect(synthesizeSpeech({ provider: 'minimax', apiKey: 'secret', text: '你好', model: 'speech-2.8-hd', voice: 'voice', speed: 1, timeoutMs: 10000 }, new AbortController().signal, requestFetch)).rejects.not.toThrow('leaked-secret');
  });

  it('does not retry HTTP failures or reveal their response bodies', async () => {
    const requestFetch = vi.fn<typeof fetch>(async () => new Response('api-key=secret', { status: 503 }));
    await expect(synthesizeSpeech({ provider: 'mimo', apiKey: 'secret', text: '你好', model: 'mimo-v2.5-tts', voice: 'mimo_default', speed: 1, timeoutMs: 10000 }, new AbortController().signal, requestFetch)).rejects.toThrow('HTTP 503');
    expect(requestFetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a pre-cancelled request before network access', async () => {
    const controller = new AbortController(); controller.abort();
    const requestFetch = vi.fn<typeof fetch>();
    await expect(synthesizeSpeech({ provider: 'mimo', apiKey: 'secret', text: '你好', model: 'mimo-v2.5-tts', voice: 'mimo_default', speed: 1, timeoutMs: 10000 }, controller.signal, requestFetch)).rejects.toMatchObject({ code: 'ABORTED' });
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it('forwards cancellation and normalizes a transport error', async () => {
    const controller = new AbortController();
    const requestFetch = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      controller.abort();
      throw new Error('secret reflected by proxy');
    });
    await expect(synthesizeSpeech({ provider: 'mimo', apiKey: 'secret', text: '你好', model: 'mimo-v2.5-tts', voice: 'mimo_default', speed: 1, timeoutMs: 10000 }, controller.signal, requestFetch)).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('rejects malformed or non-WAV audio and incomplete results', async () => {
    const request = { provider: 'mimo' as const, apiKey: 'secret', text: '你好', model: 'mimo-v2.5-tts', voice: 'mimo_default', speed: 1, timeoutMs: 10000 };
    const badAudio = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { audio: { data: Buffer.from('not audio').toString('base64') } } }] })));
    await expect(synthesizeSpeech(request, new AbortController().signal, badAudio)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    const incomplete = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { audio: { data: wave.toString('base64') } } }] })));
    await expect(synthesizeSpeech(request, new AbortController().signal, incomplete)).rejects.toThrow('未完整完成');
  });

  it('refuses responses above the declared byte bound without reading JSON', async () => {
    const requestFetch = vi.fn<typeof fetch>(async () => new Response('{}', { headers: { 'content-length': String(40 * 1024 * 1024) } }));
    await expect(synthesizeSpeech({ provider: 'mimo', apiKey: 'secret', text: '你好', model: 'mimo-v2.5-tts', voice: 'mimo_default', speed: 1, timeoutMs: 10000 }, new AbortController().signal, requestFetch)).rejects.toThrow('大小上限');
  });

  it('also validates direct management-preview requests before network access', async () => {
    const requestFetch = vi.fn<typeof fetch>(async () => response());
    await expect(synthesizeSpeech({ provider: 'mimo', apiKey: 'secret', text: '你'.repeat(5001), model: 'mimo-v2.5-tts', voice: 'mimo_default', speed: 1, timeoutMs: 10000 }, new AbortController().signal, requestFetch)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(synthesizeSpeech({ provider: 'mimo', apiKey: 'secret', text: '你好', model: 'mimo-v2.5-tts-voiceclone', voice: 'mimo_default', speed: 1, timeoutMs: 10000 }, new AbortController().signal, requestFetch)).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    expect(requestFetch).not.toHaveBeenCalled();
  });
});

describe('scoped generation and actual delivery', () => {
  it('keeps generated files in the host namespace and separates generation from sending', async () => {
    const { host, sent } = await fixture();
    const requestFetch = vi.fn<typeof fetch>(async () => response());
    const result = await generateSpeech(host, settings(), { text: '你好' }, execution('../../same-call'), { fetch: requestFetch });
    expect(result.filePath.startsWith(join(host.dataDir, 'a', 'speech'))).toBe(true);
    expect(basename(result.filePath)).toMatch(/^speech-[a-f0-9]{40}\.wav$/);
    expect(await readFile(result.filePath)).toEqual(wave);
    expect(result.delivery).toBe('not_requested');
    expect(sent).not.toHaveBeenCalled();
    const names = await readdir(join(host.dataDir, 'a', 'speech'));
    const record = await readFile(join(host.dataDir, 'a', 'speech', names.find(name => name.endsWith('.json'))!), 'utf8');
    expect(record).not.toContain('mimo-secret');
  });

  it('uses independent provider credentials and reports a confirmed QQ receipt', async () => {
    const { host, credentials, sent } = await fixture();
    const requestFetch = vi.fn<typeof fetch>(async () => response('minimax'));
    const result = await generateSpeech(host, settings(), { text: '你好', provider: 'minimax', send: true, target: 'group:friends' }, execution(), { fetch: requestFetch });
    expect(credentials).toHaveBeenCalledExactlyOnceWith('minimax');
    expect(result.delivery).toBe('sent');
    expect(result.receipt).toEqual({ status: 'accepted', messageId: 'sent-1', target: 'group:friends' });
    expect(result.target).toBe('group:friends'); expect(result.requestedTarget).toBe('group:friends');
    expect(sent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'a' }), result.filePath, 'group:friends', expect.any(AbortSignal));
  });

  it('does not charge when no trustworthy conversation scope exists', async () => {
    const { host, credentials } = await fixture();
    const requestFetch = vi.fn<typeof fetch>(async () => response());
    await expect(generateSpeech(host, settings(), { text: '你好' }, execution('x', { id: 'stranger' }), { fetch: requestFetch })).rejects.toMatchObject({ code: 'NO_SCOPE' });
    expect(credentials).not.toHaveBeenCalled();
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it('checks autonomous authorization before resolving credentials or making a request', async () => {
    const { host, credentials } = await fixture();
    const requestFetch = vi.fn<typeof fetch>(async () => response());
    await expect(generateSpeech(host, settings(), { text: '你好', send: true, target: 'c2c:friend' }, execution('x', { id: 'life' }), {
      fetch: requestFetch, beforeGenerate: () => { throw new Error('自主语音已关闭'); },
    })).rejects.toThrow('自主语音已关闭');
    expect(credentials).not.toHaveBeenCalled();
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it('does not expose credential-service exception details', async () => {
    const { host, credentials } = await fixture();
    credentials.mockRejectedValue(new Error('the credential is super-secret'));
    const requestFetch = vi.fn<typeof fetch>(async () => response());
    await expect(generateSpeech(host, settings(), { text: '你好' }, execution(), { fetch: requestFetch })).rejects.toThrow('无法读取');
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it('reuses a settled invocation and prevents duplicate sending', async () => {
    const { host, sent } = await fixture();
    const requestFetch = vi.fn<typeof fetch>(async () => response());
    const args = { text: '你好', send: true, target: 'group:friends' };
    const first = await generateSpeech(host, settings(), args, execution(), { fetch: requestFetch });
    const second = await generateSpeech(host, settings(), args, execution(), { fetch: requestFetch });
    expect(second).toMatchObject({ fileName: first.fileName, delivery: 'sent', target: 'group:friends', reused: true });
    expect(requestFetch).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('retains generated audio when sending fails and does not send it again automatically', async () => {
    const { host, sent } = await fixture(); sent.mockRejectedValue(new Error('platform connection lost'));
    const requestFetch = vi.fn<typeof fetch>(async () => response());
    const args = { text: '你好', send: true, target: 'group:friends' };
    const first = await generateSpeech(host, settings(), args, execution(), { fetch: requestFetch });
    expect(first.generation).toBe('completed');
    expect(first.delivery).toBe('unknown');
    expect(await readFile(first.filePath)).toEqual(wave);
    const second = await generateSpeech(host, settings(), args, execution(), { fetch: requestFetch });
    expect(second.delivery).toBe('unknown');
    expect(requestFetch).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('keeps only platform evidence and does not mistake an empty SDK result for delivery', async () => {
    const { host, sent } = await fixture();
    sent.mockResolvedValue({ apiKey: 'sdk-secret', internal: { headers: { authorization: 'secret' } } });
    const requestFetch = vi.fn<typeof fetch>(async () => response());
    const result = await generateSpeech(host, settings(), { text: '你好', send: true, target: 'group:friends' }, execution(), { fetch: requestFetch });
    expect(result.delivery).toBe('unknown');
    expect(result.receipt).toEqual({});
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('does not repeat provider requests after an unknown transport outcome', async () => {
    const { host } = await fixture();
    const requestFetch = vi.fn<typeof fetch>(async () => { throw new Error('provider may already have charged'); });
    await expect(generateSpeech(host, settings(), { text: '你好' }, execution(), { fetch: requestFetch })).rejects.toMatchObject({ code: 'UNKNOWN' });
    await expect(generateSpeech(host, settings(), { text: '你好' }, execution(), { fetch: requestFetch })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(requestFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects changed arguments under the same invocation identity', async () => {
    const { host } = await fixture();
    const requestFetch = vi.fn<typeof fetch>(async () => response());
    await generateSpeech(host, settings(), { text: '你好' }, execution(), { fetch: requestFetch });
    await expect(generateSpeech(host, settings(), { text: '另一个文本' }, execution(), { fetch: requestFetch })).rejects.toMatchObject({ code: 'CALL_CONFLICT' });
    expect(requestFetch).toHaveBeenCalledTimes(1);
  });

  it('shares no files or metadata between two QQ namespaces', async () => {
    const { host } = await fixture();
    const requestFetch = vi.fn<typeof fetch>(async () => response());
    const a = await generateSpeech(host, settings(), { text: '甲的私人文本' }, execution('same', { id: 'a' }), { fetch: requestFetch });
    const b = await generateSpeech(host, settings(), { text: '乙的私人文本' }, execution('same', { id: 'b' }), { fetch: requestFetch });
    expect(a.filePath).not.toBe(b.filePath);
    const own = await listSpeechFiles(host, { id: 'a' });
    expect(own).toHaveLength(1);
    expect(own[0]?.filePath).toBe(a.filePath);
  });

  it('does not regenerate a tampered settled audio file', async () => {
    const { host } = await fixture();
    const requestFetch = vi.fn<typeof fetch>(async () => response());
    const saved = await generateSpeech(host, settings(), { text: '你好' }, execution(), { fetch: requestFetch });
    await writeFile(saved.filePath, 'tampered');
    await expect(generateSpeech(host, settings(), { text: '你好' }, execution(), { fetch: requestFetch })).rejects.toMatchObject({ code: 'LOCAL_STATE' });
    expect(requestFetch).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent duplicate invocations into one request', async () => {
    const { host } = await fixture();
    const requestFetch = vi.fn<typeof fetch>(async () => response());
    const [a, b] = await Promise.all([
      generateSpeech(host, settings(), { text: '你好' }, execution(), { fetch: requestFetch }),
      generateSpeech(host, settings(), { text: '你好' }, execution(), { fetch: requestFetch }),
    ]);
    expect(a.fileName).toBe(b.fileName); expect(a.reused || b.reused).toBe(true);
    expect(requestFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects disabled, unsupported and oversized input before a request', async () => {
    const { host } = await fixture();
    const requestFetch = vi.fn<typeof fetch>(async () => response());
    await expect(generateSpeech(host, { ...settings(), enabled: false }, { text: '你好' }, execution(), { fetch: requestFetch })).rejects.toMatchObject({ code: 'DISABLED' });
    await expect(generateSpeech(host, settings(), { text: '你'.repeat(1001) }, execution(), { fetch: requestFetch })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(generateSpeech(host, settings(), { text: '你好', emotion: 'happy' }, execution(), { fetch: requestFetch })).rejects.toThrow('MiMo');
    const unsupported = settings(); unsupported.mimo.model = 'mimo-v2.5-tts-voiceclone';
    await expect(generateSpeech(host, unsupported, { text: '你好' }, execution(), { fetch: requestFetch })).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it('registers the DSH tool with canonical output and a meaningful model rendering', async () => {
    const { host } = await fixture();
    const definitions: Array<{ name: string; execute: (args: unknown, exec: ModuleExecution) => Promise<Record<string, unknown>>; output: { render: (args: unknown, value: unknown) => unknown } }> = [];
    (host.ctx as unknown as { get: () => unknown }).get = () => ({ register: (definition: typeof definitions[number]) => definitions.push(definition) });
    registerSpeechTools(host, settings, { fetch: vi.fn<typeof fetch>(async () => response()) });
    expect(definitions[0]?.name).toBe('zeta_speech_generate');
    const value = await definitions[0]!.execute({ text: '你好' }, execution());
    expect(value.generation).toBe('completed');
    expect(definitions[0]!.output.render({}, value)).toEqual([{ type: 'text', text: expect.stringContaining('未请求发送') }]);
  });
});

describe('speech argument boundaries', () => {
  it('rejects hidden properties and targets without a sending operation', () => {
    expect(() => validateSpeechArguments({ text: '你好', namespace: 'someone-else' }, settings())).toThrow('参数无效');
    expect(() => validateSpeechArguments({ text: '你好', target: 'c2c:other' }, settings())).toThrow('只有请求发送');
    expect(() => validateSpeechArguments({ text: '你好', send: true, target: '../../other' }, settings())).toThrow('格式');
  });
});

describe('explicit destinations, request-level synthesis and existing speech delivery', () => {
  it('rejects missing or unauthorized targets before credentials, hooks or paid generation', async () => {
    const { host, credentials, sent } = await fixture(), beforeGenerate = vi.fn();
    const requestFetch = vi.fn<typeof fetch>(async () => response());
    await expect(generateSpeech(host, settings(), { text: '群自我介绍', send: true }, execution(), { fetch: requestFetch, beforeGenerate })).rejects.toMatchObject({ code: 'TARGET_REQUIRED' });
    expect(beforeGenerate).not.toHaveBeenCalled();
    const check = vi.fn(() => { throw new Error('Unknown or forbidden group'); }); host.validateSendTarget = check;
    await expect(generateSpeech(host, settings(), { text: '群自我介绍', send: true, target: 'group:unknown' }, execution(), { fetch: requestFetch, beforeGenerate })).rejects.toThrow('Unknown or forbidden group');
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'group:unknown', 'speech');
    expect(credentials).not.toHaveBeenCalled(); expect(requestFetch).not.toHaveBeenCalled(); expect(sent).not.toHaveBeenCalled(); expect(beforeGenerate).not.toHaveBeenCalled();
  });
  it('charges and delivers once for different callIds in the same real request', async () => {
    const { host, sent, credentials } = await fixture(); host.requestKeyFor = () => 'qq-real-message-ids';
    const requestFetch = vi.fn<typeof fetch>(async () => response()), args = { text: ' 我是小鲸鱼。 ', send: true, target: 'group:friends' };
    const first = await generateSpeech(host, settings(), args, execution('call-1'), { fetch: requestFetch });
    const repeated = await generateSpeech(host, settings(), { ...args, text: '我是小鲸鱼。' }, execution('call-2'), { fetch: requestFetch });
    expect(repeated).toMatchObject({ fileName: first.fileName, generation: 'completed', delivery: 'sent', target: 'group:friends', reused: true });
    expect(repeated.notice).toContain('不要重复'); expect(requestFetch).toHaveBeenCalledTimes(1); expect(credentials).toHaveBeenCalledTimes(1); expect(sent).toHaveBeenCalledTimes(1);
  });
  it('coalesces concurrent semantic generation and permits a generated-only result to be sent without another charge', async () => {
    const { host, sent } = await fixture(); host.requestKeyFor = () => 'one-source-message';
    const requestFetch = vi.fn<typeof fetch>(async () => response());
    const [preview, delivered] = await Promise.all([
      generateSpeech(host, settings(), { text: '同一条介绍' }, execution('preview'), { fetch: requestFetch }),
      generateSpeech(host, settings(), { text: '同一条介绍', send: true, target: 'group:friends' }, execution('send'), { fetch: requestFetch }),
    ]);
    expect(preview.fileName).toBe(delivered.fileName); expect(delivered).toMatchObject({ target: 'group:friends', delivery: 'sent' });
    expect(preview.reused || delivered.reused).toBe(true);
    expect(requestFetch).toHaveBeenCalledTimes(1); expect(sent).toHaveBeenCalledTimes(1);
  });
  it('never treats a private-chat receipt as delivery to a newly requested group', async () => {
    const { host, sent, credentials } = await fixture(); host.requestKeyFor = () => 'same-request';
    const requestFetch = vi.fn<typeof fetch>(async () => response());
    const first = await generateSpeech(host, settings(), { text: '自我介绍', send: true, target: 'c2c:a' }, execution('first'), { fetch: requestFetch });
    await expect(generateSpeech(host, settings(), { text: '自我介绍', send: true, target: 'group:friends' }, execution('second'), { fetch: requestFetch })).rejects.toMatchObject({ code: 'TARGET_CONFLICT' });
    const corrected = await sendSpeech(host, { fileName: first.fileName, target: 'group:friends' }, execution('reuse-correct-target'));
    expect(corrected).toMatchObject({ target: 'group:friends', requestedTarget: 'group:friends', delivery: 'sent', reused: true });
    expect(requestFetch).toHaveBeenCalledTimes(1); expect(credentials).toHaveBeenCalledTimes(1); expect(sent.mock.calls.map(call => call[2])).toEqual(['c2c:a', 'group:friends']);
    const listed = await listSpeechFiles(host, { id: 'a' }); expect(listed[0]?.target).toBe('group:friends');
  });
  it('preserves an unknown paid outcome across new model call ids', async () => {
    const { host, sent } = await fixture(); host.requestKeyFor = () => 'same-request';
    const requestFetch = vi.fn<typeof fetch>(async () => { throw new Error('provider outcome unknown'); });
    await expect(generateSpeech(host, settings(), { text: '介绍' }, execution('first'), { fetch: requestFetch })).rejects.toMatchObject({ code: 'UNKNOWN' });
    await expect(generateSpeech(host, settings(), { text: '介绍' }, execution('second'), { fetch: requestFetch })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(requestFetch).toHaveBeenCalledTimes(1); expect(sent).not.toHaveBeenCalled();
  });
  it('records cancellation after provider submission and never charges that request again', async () => {
    const { host, sent } = await fixture(); host.requestKeyFor = () => 'same-source-request';
    const controller = new AbortController(), requestFetch = vi.fn<typeof fetch>(async () => { controller.abort(); return response(); });
    await expect(generateSpeech(host, settings(), { text: '介绍', send: true, target: 'group:friends' }, { ...execution('first'), signal: controller.signal }, { fetch: requestFetch })).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(generateSpeech(host, settings(), { text: '介绍', send: true, target: 'group:friends' }, execution('second'), { fetch: requestFetch })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(requestFetch).toHaveBeenCalledTimes(1); expect(sent).not.toHaveBeenCalled();
  });
  it('retains a generated file if cancellation occurs before dispatch and reuses it on a new explicit request', async () => {
    const { host, sent } = await fixture(); let requestKey = 'first-request'; host.requestKeyFor = () => requestKey;
    const controller = new AbortController(), requestFetch = vi.fn<typeof fetch>(async () => response());
    let checks = 0; host.validateSendTarget = () => { if (++checks === 2) controller.abort(); };
    await expect(generateSpeech(host, settings(), { text: '介绍', send: true, target: 'group:friends' }, { ...execution(), signal: controller.signal }, { fetch: requestFetch })).rejects.toMatchObject({ code: 'ABORTED' });
    const [audio] = await listSpeechFiles(host, { id: 'a' }); expect(audio).toMatchObject({ generation: 'completed', delivery: 'not_requested' });
    expect(sent).not.toHaveBeenCalled(); requestKey = 'explicit-send-after-stop';
    expect(await sendSpeech(host, { fileName: audio!.fileName, target: 'group:friends' }, execution('send'))).toMatchObject({ delivery: 'sent', target: 'group:friends', reused: true });
    expect(requestFetch).toHaveBeenCalledTimes(1); expect(sent).toHaveBeenCalledTimes(1);
  });
  it('reuses pre-upgrade full-fingerprint records instead of charging under the new request identity', async () => {
    const { host, sent } = await fixture(), requestFetch = vi.fn<typeof fetch>(async () => response());
    const args = { text: '旧记录', send: true, target: 'group:friends' };
    const old = await generateSpeech(host, settings(), args, execution('old-call'), { fetch: requestFetch });
    const path = old.filePath.replace(/\.wav$/u, '.json'), manifest = JSON.parse(await readFile(path, 'utf8')); delete manifest.generationFingerprint;
    await writeFile(path, JSON.stringify(manifest)); host.requestKeyFor = () => 'new-runtime-real-message';
    const reused = await generateSpeech(host, settings(), args, execution('old-call'), { fetch: requestFetch });
    expect(reused).toMatchObject({ fileName: old.fileName, target: 'group:friends', reused: true });
    expect(requestFetch).toHaveBeenCalledTimes(1); expect(sent).toHaveBeenCalledTimes(1);
  });
  it('keeps an incomplete legacy call-id manifest authoritative after the host gains request identities', async () => {
    const { host, sent } = await fixture(), requestFetch = vi.fn<typeof fetch>(async () => { throw new Error('old interrupted request'); });
    await expect(generateSpeech(host, settings(), { text: '旧请求' }, execution('old-call'), { fetch: requestFetch })).rejects.toMatchObject({ code: 'UNKNOWN' });
    const directory = join(host.dataDir, 'a', 'speech'), name = (await readdir(directory)).find(name => name.endsWith('.json'))!;
    const path = join(directory, name), manifest = JSON.parse(await readFile(path, 'utf8')); delete manifest.generationFingerprint;
    await writeFile(path, JSON.stringify(manifest)); host.requestKeyFor = () => 'upgraded-request-id';
    await expect(generateSpeech(host, settings(), { text: '旧请求' }, execution('old-call'), { fetch: requestFetch })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(requestFetch).toHaveBeenCalledTimes(1); expect(sent).not.toHaveBeenCalled();
  });
  it('reuses verified audio across later requests and serializes duplicate delivery per target', async () => {
    const { host, sent, credentials } = await fixture(), requestFetch = vi.fn<typeof fetch>(async () => response());
    const audio = await generateSpeech(host, settings(), { text: '已经生成的介绍' }, execution('generate'), { fetch: requestFetch });
    const values = await Promise.all(['first-send', 'new-model-call', 'another-user-turn'].map(id => sendSpeech(host, { fileName: audio.fileName, target: 'group:friends' }, execution(id))));
    expect(values.every(value => value.delivery === 'sent' && value.target === 'group:friends')).toBe(true);
    expect(sent).toHaveBeenCalledTimes(1); expect(credentials).toHaveBeenCalledTimes(1); expect(requestFetch).toHaveBeenCalledTimes(1);
  });
  it('does not repeat unknown or missing-target platform receipts through the reuse tool', async () => {
    const { host, sent } = await fixture(), requestFetch = vi.fn<typeof fetch>(async () => response());
    sent.mockResolvedValue({ status: 'accepted', messageId: 'receipt-without-target' } as never);
    const audio = await generateSpeech(host, settings(), { text: '介绍', send: true, target: 'group:friends' }, execution(), { fetch: requestFetch });
    expect(audio.delivery).toBe('unknown'); expect(audio.target).toBeUndefined(); expect(audio.requestedTarget).toBe('group:friends');
    const again = await sendSpeech(host, { fileName: audio.fileName, target: 'group:friends' }, execution('later'));
    expect(again).toMatchObject({ delivery: 'unknown', reused: true }); expect(sent).toHaveBeenCalledTimes(1); expect(requestFetch).toHaveBeenCalledTimes(1);
  });
  it('permits one explicit resend in a new real request without another synthesis charge', async () => {
    const { host, sent, credentials } = await fixture(), requestFetch = vi.fn<typeof fetch>(async () => response());
    let requestKey = 'first-user-message'; host.requestKeyFor = () => requestKey;
    const audio = await generateSpeech(host, settings(), { text: '介绍', send: true, target: 'group:friends' }, execution('generate'), { fetch: requestFetch });
    await sendSpeech(host, { fileName: audio.fileName, target: 'group:friends' }, execution('same-user-message-different-call'));
    expect(sent).toHaveBeenCalledTimes(1);
    requestKey = 'explicit-resend-user-message';
    const [first, repeated] = await Promise.all(['send-1', 'send-2'].map(callId => sendSpeech(host, { fileName: audio.fileName, target: 'group:friends' }, execution(callId))));
    expect([first, repeated]).toEqual([expect.objectContaining({ target: 'group:friends', delivery: 'sent', reused: true }), expect.objectContaining({ target: 'group:friends', delivery: 'sent', reused: true })]);
    expect(sent).toHaveBeenCalledTimes(2); expect(requestFetch).toHaveBeenCalledTimes(1); expect(credentials).toHaveBeenCalledTimes(1);
    requestKey = 'first-user-message';
    await sendSpeech(host, { fileName: audio.fileName, target: 'group:friends' }, execution('old-request-replayed'));
    expect(sent).toHaveBeenCalledTimes(2);
  });
  it('keeps an unknown delivery for the original request and permits a new user request to resend the existing file', async () => {
    const { host, sent } = await fixture(), requestFetch = vi.fn<typeof fetch>(async () => response());
    let requestKey = 'first-user-message'; host.requestKeyFor = () => requestKey;
    sent.mockRejectedValueOnce(new Error('SDK response lost'));
    const audio = await generateSpeech(host, settings(), { text: '介绍', send: true, target: 'group:friends' }, execution(), { fetch: requestFetch });
    expect(audio.delivery).toBe('unknown');
    await sendSpeech(host, { fileName: audio.fileName, target: 'group:friends' }, execution('same-request'));
    expect(sent).toHaveBeenCalledTimes(1);
    requestKey = 'new-explicit-user-request';
    expect(await sendSpeech(host, { fileName: audio.fileName, target: 'group:friends' }, execution('retry-existing-file'))).toMatchObject({ delivery: 'sent', target: 'group:friends', reused: true });
    requestKey = 'first-user-message';
    expect(await sendSpeech(host, { fileName: audio.fileName, target: 'group:friends' }, execution('old-request'))).toMatchObject({ delivery: 'unknown', reused: true });
    expect(sent).toHaveBeenCalledTimes(2); expect(requestFetch).toHaveBeenCalledTimes(1);
  });
  it('reports a mismatching actual target without claiming success for the requested destination', async () => {
    const { host, sent } = await fixture(); sent.mockResolvedValue({ status: 'accepted', messageId: 'unexpected-route', target: 'c2c:a' });
    const audio = await generateSpeech(host, settings(), { text: '介绍', send: true, target: 'group:friends' }, execution(), { fetch: vi.fn<typeof fetch>(async () => response()) });
    expect(audio).toMatchObject({ delivery: 'unknown', target: 'c2c:a', requestedTarget: 'group:friends' });
  });
  it('refuses arbitrary, missing, tampered or pre-cancelled reusable audio', async () => {
    const { host, sent, credentials } = await fixture(), requestFetch = vi.fn<typeof fetch>(async () => response());
    await expect(sendSpeech(host, { fileName: '../../private.wav', target: 'group:friends' }, execution())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(sendSpeech(host, { fileName: 'speech-' + 'a'.repeat(40) + '.wav' }, execution())).rejects.toMatchObject({ code: 'TARGET_REQUIRED' });
    const audio = await generateSpeech(host, settings(), { text: '介绍' }, execution(), { fetch: requestFetch });
    const cancelled = new AbortController(); cancelled.abort();
    await expect(sendSpeech(host, { fileName: audio.fileName, target: 'group:friends' }, { ...execution('cancelled'), signal: cancelled.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    await writeFile(audio.filePath, 'tampered');
    await expect(sendSpeech(host, { fileName: audio.fileName, target: 'group:friends' }, execution('tampered'))).rejects.toMatchObject({ code: 'LOCAL_STATE' });
    expect(sent).not.toHaveBeenCalled(); expect(credentials).toHaveBeenCalledTimes(1); expect(requestFetch).toHaveBeenCalledTimes(1);
  });
  it('registers reuse tools with explicit target schema and separates actual delivery from generation in rendering', async () => {
    const { host } = await fixture(), definitions: any[] = [];
    (host.ctx as unknown as { get: () => unknown }).get = () => ({ register: (definition: unknown) => definitions.push(definition) });
    const requestFetch = vi.fn<typeof fetch>(async () => response()); registerSpeechTools(host, settings, { fetch: requestFetch });
    expect(definitions.map(value => value.name)).toEqual(['zeta_speech_generate', 'zeta_speech_list', 'zeta_speech_send']);
    expect(definitions[2].parameters.required).toEqual(['fileName', 'target']);
    const audio = await definitions[0].execute({ text: '介绍' }, execution());
    expect(definitions[0].output.render({}, audio)[0].text).toContain('尚未发送到任何QQ目标');
    const listed = await definitions[1].execute({}, execution('list')); expect(listed.items[0].fileName).toBe(audio.fileName);
    const delivered = await definitions[2].execute({ fileName: audio.fileName, target: 'group:friends' }, execution('send'));
    const rendered = definitions[2].output.render({}, delivered)[0].text;
    expect(rendered).toContain('实际目标：group:friends'); expect(rendered).toContain('不要重复'); expect(requestFetch).toHaveBeenCalledTimes(1);
  });
});
