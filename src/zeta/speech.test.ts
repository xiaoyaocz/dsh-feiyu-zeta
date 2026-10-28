import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { ModuleExecution, ModuleHost, SpeechSettings } from './contracts.ts';
import { generateSpeech, listSpeechFiles, registerSpeechTools, SPEECH_ENDPOINTS, synthesizeSpeech, validateSpeechArguments } from './speech.ts';

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
  const sent = vi.fn(async () => ({ messageId: 'sent-1' }));
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
    const result = await generateSpeech(host, settings(), { text: '你好', provider: 'minimax', send: true }, execution(), { fetch: requestFetch });
    expect(credentials).toHaveBeenCalledExactlyOnceWith('minimax');
    expect(result.delivery).toBe('sent');
    expect(result.receipt).toEqual({ messageId: 'sent-1' });
    expect(sent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'a' }), result.filePath, undefined, expect.any(AbortSignal));
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
    const args = { text: '你好', send: true };
    const first = await generateSpeech(host, settings(), args, execution(), { fetch: requestFetch });
    const second = await generateSpeech(host, settings(), args, execution(), { fetch: requestFetch });
    expect(second).toEqual(first);
    expect(requestFetch).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('retains generated audio when sending fails and does not send it again automatically', async () => {
    const { host, sent } = await fixture(); sent.mockRejectedValue(new Error('platform connection lost'));
    const requestFetch = vi.fn<typeof fetch>(async () => response());
    const args = { text: '你好', send: true };
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
    const result = await generateSpeech(host, settings(), { text: '你好', send: true }, execution(), { fetch: requestFetch });
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
    expect(a).toEqual(b);
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
