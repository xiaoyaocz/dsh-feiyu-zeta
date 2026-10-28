import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { ModuleExecution, ModuleHost, SpeechSettings } from './contracts.ts';
import { legacyMaterialOwner, materialActorKey, migratedOperationId } from './shared-materials.ts';

export const SPEECH_TOOL_NAME = 'zeta_speech_generate';
export const SPEECH_ENDPOINTS = {
  mimo: 'https://api.xiaomimimo.com/v1/chat/completions',
  minimax: 'https://api.minimax.cn/v1/t2a_v2',
} as const;
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 36 * 1024 * 1024;
const MAX_TEXT_CHARACTERS = 5000;
const EMOTIONS = ['auto', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent', 'whisper'];

export interface SpeechArguments {
  text: string;
  provider?: 'mimo' | 'minimax';
  voice?: string;
  speed?: number;
  emotion?: string;
  send?: boolean;
  target?: string;
}

export interface SpeechRequest {
  provider: 'mimo' | 'minimax';
  text: string;
  model: string;
  voice: string;
  speed: number;
  emotion?: string;
  apiKey: string;
  timeoutMs: number;
}

export interface SpeechAudio {
  audio: Buffer;
  mimeType: 'audio/wav';
  providerRequestId?: string;
}

export interface SpeechResult {
  provider: 'mimo' | 'minimax';
  model: string;
  voice: string;
  filePath: string;
  fileName: string;
  mimeType: 'audio/wav';
  bytes: number;
  characters: number;
  createdAt: string;
  generation: 'completed';
  delivery: 'not_requested' | 'sent' | 'failed' | 'unknown';
  receipt?: Record<string, unknown>;
  notice?: string;
}

export class SpeechError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SpeechError';
  }
}

export interface SpeechModuleOptions {
  /** Gate autonomous costs/targets before any provider request is submitted. */
  beforeGenerate?: (args: SpeechArguments, exec: ModuleExecution) => void | Promise<void>;
  fetch?: typeof fetch;
}

interface SpeechManifest {
  version: 1;
  actorKey?: string;
  fingerprint: string;
  state: 'pending' | 'completed' | 'failed' | 'unknown';
  delivery: 'not_requested' | 'pending' | 'sent' | 'failed' | 'unknown';
  result?: SpeechResult;
  sha256?: string;
  errorCode?: string;
}

const running = new Map<string, { fingerprint: string; promise: Promise<SpeechResult> }>();
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new SpeechError('ABORTED', '语音操作已取消；已提交的请求不会自动重发。');
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function plainString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new SpeechError('INVALID_ARGUMENT', `${name}无效。`);
  }
  return value.trim();
}

export function validateSpeechArguments(value: unknown, settings: SpeechSettings): SpeechArguments {
  const args = object(value);
  if (!args || Object.keys(args).some(key => !['text', 'provider', 'voice', 'speed', 'emotion', 'send', 'target'].includes(key))) {
    throw new SpeechError('INVALID_ARGUMENT', '语音参数无效。');
  }
  if (typeof args.text !== 'string' || !args.text.trim()) throw new SpeechError('INVALID_ARGUMENT', '需要实际朗读文本。');
  const text = args.text.trim();
  const configured = settings.maxTextCharacters;
  if (!Number.isInteger(configured) || configured < 1 || configured > MAX_TEXT_CHARACTERS) {
    throw new SpeechError('INVALID_CONFIGURATION', '语音文本长度配置无效。');
  }
  if (Array.from(text).length > configured || /\u0000/u.test(text)) {
    throw new SpeechError('INVALID_ARGUMENT', `朗读文本超过${configured}字符上限或包含无效字符。`);
  }
  if (args.provider !== undefined && args.provider !== 'mimo' && args.provider !== 'minimax') {
    throw new SpeechError('INVALID_ARGUMENT', '语音服务只能选择 MiMo 或 MiniMax。');
  }
  if (args.send !== undefined && typeof args.send !== 'boolean') throw new SpeechError('INVALID_ARGUMENT', 'send 必须为布尔值。');
  if (args.speed !== undefined && (typeof args.speed !== 'number' || !Number.isFinite(args.speed) || args.speed < 0.5 || args.speed > 2)) {
    throw new SpeechError('INVALID_ARGUMENT', '语速须为 0.5–2。');
  }
  const target = args.target === undefined ? undefined : plainString(args.target, '发送目标', 300);
  if (target && !/^(c2c|group):[^\s:]+$/u.test(target)) throw new SpeechError('INVALID_ARGUMENT', '发送目标格式应为 c2c:用户ID 或 group:群ID。');
  if (target && args.send !== true) throw new SpeechError('INVALID_ARGUMENT', '只有请求发送时才能指定目标。');
  return {
    text,
    ...(args.provider === undefined ? {} : { provider: args.provider as 'mimo' | 'minimax' }),
    ...(args.voice === undefined ? {} : { voice: plainString(args.voice, '声线', 256) }),
    ...(args.speed === undefined ? {} : { speed: args.speed as number }),
    ...(args.emotion === undefined ? {} : { emotion: plainString(args.emotion, '情绪', 32) }),
    ...(args.send === undefined ? {} : { send: args.send as boolean }),
    ...(target === undefined ? {} : { target }),
  };
}

function resolvedRequest(args: SpeechArguments, settings: SpeechSettings): Omit<SpeechRequest, 'apiKey'> {
  if (!settings.enabled) throw new SpeechError('DISABLED', '语音生成已关闭。');
  const provider = args.provider ?? settings.provider;
  if (provider !== 'mimo' && provider !== 'minimax') throw new SpeechError('INVALID_CONFIGURATION', '语音服务配置无效。');
  const config = settings[provider];
  if (!config) throw new SpeechError('INVALID_CONFIGURATION', '语音服务配置缺失。');
  const model = plainString(config.model, '语音模型', 100);
  const voice = plainString(args.voice ?? config.voice, '声线', 256);
  const speed = args.speed ?? config.speed;
  const emotion = args.emotion ?? (config.emotion || undefined);
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new SpeechError('INVALID_CONFIGURATION', '语速须为 0.5–2。');
  if (!Number.isInteger(settings.timeoutMs) || settings.timeoutMs < 1000 || settings.timeoutMs > 180000) {
    throw new SpeechError('INVALID_CONFIGURATION', '语音超时须为 1000–180000 毫秒。');
  }
  if (provider === 'mimo') {
    if (model !== 'mimo-v2.5-tts') throw new SpeechError('INVALID_CONFIGURATION', '首版 MiMo 语音仅支持 mimo-v2.5-tts 预置声线模型。');
    if (emotion && emotion !== 'auto') throw new SpeechError('INVALID_ARGUMENT', 'MiMo 不接受 MiniMax 的 emotion 参数。');
  } else {
    if (!/^speech-[A-Za-z0-9][A-Za-z0-9._-]{0,78}$/u.test(model)) throw new SpeechError('INVALID_CONFIGURATION', 'MiniMax Speech 模型配置无效。');
    if (emotion && !EMOTIONS.includes(emotion)) throw new SpeechError('INVALID_ARGUMENT', 'MiniMax 情绪参数无效。');
    if (emotion && ['fluent', 'whisper'].includes(emotion) && !model.startsWith('speech-2.6-')) {
      throw new SpeechError('INVALID_ARGUMENT', '当前 MiniMax 模型不支持该情绪参数。');
    }
  }
  return { provider, text: args.text, model, voice, speed, ...(emotion ? { emotion } : {}), timeoutMs: settings.timeoutMs };
}

async function readJson(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new SpeechError(response.status >= 400 && response.status < 500 && response.status !== 408 ? 'REJECTED' : 'UNKNOWN',
      `语音服务请求未成功（HTTP ${response.status}）；未自动重新提交。`);
  }
  if (!response.body) throw new SpeechError('UNKNOWN', '语音服务响应为空；未自动重新提交。');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body.cancel().catch(() => {});
    throw new SpeechError('INVALID_RESPONSE', '语音服务响应超过大小上限。');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const onAbort = (): void => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      cancelled(signal);
      const next = await reader.read();
      cancelled(signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new SpeechError('INVALID_RESPONSE', '语音服务响应超过大小上限。');
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  let result: Record<string, unknown> | undefined;
  try { result = object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { /* Never echo response bodies. */ }
  if (!result) throw new SpeechError('INVALID_RESPONSE', '语音服务返回了无效数据。');
  return result;
}

function decodeAudio(value: unknown, encoding: 'base64' | 'hex'): Buffer {
  if (typeof value !== 'string' || !value.length || value.length > MAX_RESPONSE_BYTES ||
    (encoding === 'hex' ? value.length % 2 !== 0 || !/^[\da-f]+$/iu.test(value)
      : value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value))) {
    throw new SpeechError('INVALID_RESPONSE', '语音服务返回的音频编码无效。');
  }
  const bytes = Buffer.from(value, encoding);
  if (bytes.length < 12 || bytes.length > MAX_AUDIO_BYTES || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new SpeechError('INVALID_RESPONSE', '语音服务未返回有效的 WAV 音频，或音频超过大小上限。');
  }
  return bytes;
}

/** Exactly one provider POST; all errors omit provider response text and credentials. */
export async function synthesizeSpeech(request: SpeechRequest, signal: AbortSignal, requestFetch: typeof fetch = fetch): Promise<SpeechAudio> {
  cancelled(signal);
  // The management preview can call this adapter directly, so it has the same
  // bounds as model tool execution rather than trusting a particular caller.
  const directSettings: SpeechSettings = {
    enabled: true, provider: request.provider, maxTextCharacters: MAX_TEXT_CHARACTERS, timeoutMs: request.timeoutMs,
    mimo: { model: request.model, voice: request.voice, speed: request.speed, emotion: request.emotion },
    minimax: { model: request.model, voice: request.voice, speed: request.speed, emotion: request.emotion },
  };
  const directArgs = validateSpeechArguments({ text: request.text }, directSettings);
  resolvedRequest(directArgs, directSettings);
  if (!request.apiKey?.trim() || request.apiKey.length > 16384 || /[\r\n]/u.test(request.apiKey)) {
    throw new SpeechError('NO_CREDENTIAL', '尚未配置所选语音服务的密钥。');
  }
  const combined = AbortSignal.any([signal, AbortSignal.timeout(request.timeoutMs)]);
  const mimo = request.provider === 'mimo';
  const body = mimo ? {
    model: request.model,
    messages: [
      { role: 'user', content: request.speed === 1 ? '自然清晰地朗读。' : `自然清晰地朗读，语速约为正常语速的 ${request.speed} 倍。` },
      { role: 'assistant', content: request.text },
    ],
    audio: { voice: request.voice, format: 'wav' }, stream: false,
  } : {
    model: request.model, text: request.text, stream: false,
    voice_setting: { voice_id: request.voice, speed: request.speed, vol: 1, pitch: 0,
      ...(request.emotion && request.emotion !== 'auto' ? { emotion: request.emotion } : {}) },
    audio_setting: { format: 'wav', sample_rate: 24000, channel: 1 }, output_format: 'hex',
  };
  try {
    const response = await requestFetch(SPEECH_ENDPOINTS[request.provider], {
      method: 'POST', headers: { 'content-type': 'application/json',
        ...(mimo ? { 'api-key': request.apiKey } : { authorization: `Bearer ${request.apiKey}` }) },
      body: JSON.stringify(body), signal: combined, redirect: 'error',
    });
    const result = await readJson(response, combined);
    if (mimo) {
      const choices = result.choices;
      const first = Array.isArray(choices) ? object(choices[0]) : undefined;
      if (first?.finish_reason !== undefined && first.finish_reason !== 'stop') {
        throw new SpeechError('INVALID_RESPONSE', 'MiMo 未完整完成语音合成。');
      }
      const message = object(first?.message);
      const audio = object(message?.audio);
      return { audio: decodeAudio(audio?.data, 'base64'), mimeType: 'audio/wav',
        ...(typeof result.id === 'string' ? { providerRequestId: result.id.slice(0, 128) } : {}) };
    }
    const base = object(result.base_resp);
    if (!Number.isInteger(base?.status_code)) throw new SpeechError('INVALID_RESPONSE', 'MiniMax 响应缺少服务状态。');
    if (base?.status_code !== 0) throw new SpeechError('REJECTED', `MiniMax 拒绝语音请求（服务码 ${base?.status_code as number}）。`);
    const data = object(result.data);
    if (data?.status !== 2) throw new SpeechError('INVALID_RESPONSE', 'MiniMax 未完整完成语音合成。');
    return { audio: decodeAudio(data.audio, 'hex'), mimeType: 'audio/wav',
      ...(typeof result.trace_id === 'string' ? { providerRequestId: result.trace_id.slice(0, 128) } : {}) };
  } catch (error) {
    if (combined.aborted) throw new SpeechError(signal.aborted ? 'ABORTED' : 'TIMEOUT', '语音请求已取消或超时，服务端结果可能未知；未自动重新提交。');
    if (error instanceof SpeechError) throw error;
    throw new SpeechError('UNKNOWN', '语音服务连接失败，结果可能未知；未自动重新提交。');
  }
}

async function readManifest(path: string): Promise<SpeechManifest | undefined> {
  try {
    const data = await readFile(path, 'utf8');
    if (data.length > 65536) throw new Error();
    const value = object(JSON.parse(data));
    if (value?.version !== 1 || typeof value.fingerprint !== 'string') throw new Error();
    return value as unknown as SpeechManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new SpeechError('LOCAL_STATE', '已有语音记录无法读取，未重新发起收费请求。');
  }
}

async function saveManifest(path: string, value: SpeechManifest): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}

function safeReceipt(value: Record<string, unknown>): Record<string, string | number | boolean | null> {
  // Keep platform evidence, not arbitrary SDK transport/configuration objects.
  const result: Record<string, string | number | boolean | null> = {};
  for (const key of ['status', 'outcome', 'messageId', 'fileUuid', 'target', 'fileName', 'fileSize', 'size', 'reused']) {
    const item = value[key];
    if (typeof item === 'string') result[key] = item.slice(0, 1024);
    else if (typeof item === 'number' && Number.isFinite(item)) result[key] = item;
    else if (typeof item === 'boolean' || item === null) result[key] = item;
  }
  return result;
}

/** Persisted invocation identity prevents automatic paid re-generation on replay. */
export async function generateSpeech(host: ModuleHost, settings: SpeechSettings, input: unknown, exec: ModuleExecution,
  options: SpeechModuleOptions = {}): Promise<SpeechResult> {
  cancelled(exec.signal);
  const args = validateSpeechArguments(input, settings);
  const request = resolvedRequest(args, settings);
  if (!host.bindingFor(exec.agent) && !host.isLifeAgent(exec.agent)) {
    throw new SpeechError('NO_SCOPE', '当前会话尚未关联 dsh-feiyu-zeta，不能生成或读取语音。');
  }
  await options.beforeGenerate?.(args, exec);
  cancelled(exec.signal);
  const directory = await host.directoryFor(exec.agent, 'speech');
  if (!isAbsolute(directory)) throw new SpeechError('LOCAL_STATE', '语音目录必须是宿主提供的绝对路径。');
  await mkdir(directory, { recursive: true });
  const actorKey = materialActorKey(host, exec.agent), callId = exec.callId || randomUUID();
  const operation = await migratedOperationId(host.dataDir, 'speech', legacyMaterialOwner(host, exec.agent), digest(callId).slice(0, 40)) ?? digest(`${actorKey}:${callId}`).slice(0, 40);
  cancelled(exec.signal); host.requireWritable?.();
  const fileName = `speech-${operation}.wav`;
  const filePath = join(directory, fileName);
  const manifestPath = join(directory, `speech-${operation}.json`);
  const fingerprint = digest(JSON.stringify({ ...request, send: args.send === true, target: args.target ?? null }));
  const active = running.get(manifestPath);
  if (active) {
    if (active.fingerprint !== fingerprint) throw new SpeechError('CALL_CONFLICT', '同一调用标识对应不同语音参数。');
    return active.promise;
  }
  const promise = (async (): Promise<SpeechResult> => {
    let manifest = await readManifest(manifestPath);
    if (manifest && manifest.fingerprint !== fingerprint) throw new SpeechError('CALL_CONFLICT', '同一调用标识对应不同语音参数。');
    let result: SpeechResult;
    if (manifest) {
      if (manifest.state !== 'completed' || !manifest.result) throw new SpeechError('OUTCOME_UNKNOWN', '此前语音请求未确认完成，不会自动重新生成；请检查语音记录。');
      let audio: Buffer;
      try { audio = await readFile(filePath); } catch { throw new SpeechError('LOCAL_STATE', '已生成语音文件不可用，未重新发起收费请求。'); }
      if (manifest.sha256 !== digest(audio)) throw new SpeechError('LOCAL_STATE', '已生成语音校验失败，未重新发起收费请求。');
      result = { ...manifest.result, filePath, fileName };
      if (manifest.delivery === 'pending' || manifest.delivery === 'unknown') {
        return { ...result, delivery: 'unknown', notice: '此前发送结果未知，未自动重发。' };
      }
      return result;
    }
    let apiKey: string;
    try { apiKey = await host.resolveApiKey(request.provider); }
    catch { throw new SpeechError('NO_CREDENTIAL', '无法读取所选语音服务的密钥。'); }
    if (!apiKey?.trim()) throw new SpeechError('NO_CREDENTIAL', '尚未配置所选语音服务的密钥。');
    cancelled(exec.signal);
    manifest = { version: 1, actorKey, fingerprint, state: 'pending', delivery: 'not_requested' };
    try { await writeFile(manifestPath, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 }); }
    catch { throw new SpeechError('LOCAL_STATE', '语音调用记录已存在或无法写入，未发起请求。'); }
    try {
      const response = await synthesizeSpeech({ ...request, apiKey }, exec.signal, options.fetch);
      cancelled(exec.signal);
      await writeFile(filePath, response.audio, { flag: 'wx', mode: 0o600 });
      result = { provider: request.provider, model: request.model, voice: request.voice, filePath, fileName,
        mimeType: response.mimeType, bytes: response.audio.length, characters: Array.from(args.text).length,
        createdAt: new Date().toISOString(), generation: 'completed', delivery: 'not_requested' };
      manifest = { ...manifest, state: 'completed', result, sha256: digest(response.audio) };
      await saveManifest(manifestPath, manifest);
    } catch (error) {
      manifest.state = error instanceof SpeechError && error.code === 'REJECTED' ? 'failed' : 'unknown';
      manifest.errorCode = error instanceof SpeechError ? error.code : 'LOCAL_STATE';
      await saveManifest(manifestPath, manifest).catch(() => {});
      if (error instanceof SpeechError) throw error;
      throw new SpeechError('LOCAL_STATE', '语音结果未能完整保存；不会自动重新生成。');
    }
    if (args.send) {
      cancelled(exec.signal);
      manifest.delivery = 'pending';
      await saveManifest(manifestPath, manifest);
      try {
        const receipt = safeReceipt(await host.sendFile(exec.agent, filePath, args.target, exec.signal));
        const delivery = receipt.outcome === 'failed' || receipt.status === 'failed' ? 'failed'
          : receipt.outcome === 'unknown' || receipt.status === 'unknown' ? 'unknown'
            : receipt.outcome === 'sent' || receipt.status === 'accepted' || receipt.status === 'sent'
              || typeof receipt.messageId === 'string' && receipt.messageId.length > 0 ? 'sent' : 'unknown';
        result = { ...result, delivery, receipt };
      } catch {
        result = { ...result, delivery: 'unknown', notice: '语音已生成，但发送结果未确认；未自动重发。' };
      }
      manifest = { ...manifest, delivery: result.delivery, result };
      await saveManifest(manifestPath, manifest);
    }
    return result;
  })();
  running.set(manifestPath, { fingerprint, promise });
  try { return await promise; } finally { if (running.get(manifestPath)?.promise === promise) running.delete(manifestPath); }
}

/** Read-only metadata for the authenticated management UI, scoped by the host. */
export async function listSpeechFiles(host: ModuleHost, agent: unknown, limit = 20): Promise<SpeechResult[]> {
  if (!host.bindingFor(agent) && !host.isLifeAgent(agent)) throw new SpeechError('NO_SCOPE', '当前会话尚未关联 dsh-feiyu-zeta。');
  const { readdir } = await import('node:fs/promises');
  const directory = await host.directoryFor(agent, 'speech');
  const count = Math.max(1, Math.min(100, Number.isInteger(limit) ? limit : 20));
  let names: string[];
  try { names = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const values: SpeechResult[] = [];
  for (const name of names.filter(name => /^speech-[a-f0-9]{40}\.json$/u.test(name))) {
    const saved = await readManifest(join(directory, name));
    if (saved?.state === 'completed' && saved.result) {
      const fileName = name.replace(/\.json$/u, '.wav');
      values.push({ ...saved.result, fileName, filePath: join(directory, fileName),
        delivery: saved.delivery === 'pending' ? 'unknown' : saved.result.delivery });
    }
  }
  return values.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, count);
}

export function registerSpeechTools(host: ModuleHost, getSettings: () => SpeechSettings | Promise<SpeechSettings>, options: SpeechModuleOptions = {}): void {
  const tools = host.ctx.get('tools') as { register(definition: unknown): unknown } | undefined;
  if (!tools?.register) throw new SpeechError('NO_TOOLS', 'DSH 工具服务未就绪。');
  tools.register({
    name: SPEECH_TOOL_NAME,
    description: '生成一段真实 WAV 语音，可选发送到当前 QQ 或已获允许的明确目标。支持 MiMo 与 MiniMax；生成成功和发送成功分别记录。不要用此工具重新生成结果未知的旧请求。',
    parameters: { type: 'object', properties: {
      text: { type: 'string', description: '需要朗读的实际文本。' },
      provider: { type: 'string', enum: ['mimo', 'minimax'], description: '省略时使用配置的默认语音服务。' },
      voice: { type: 'string', description: '可选的服务声线 ID。' },
      speed: { type: 'number', minimum: 0.5, maximum: 2, description: '语速；MiMo 通过朗读提示近似控制，MiniMax 使用原生参数。' },
      emotion: { type: 'string', enum: EMOTIONS, description: 'MiniMax 情绪参数；MiMo 不接受此项。' },
      send: { type: 'boolean', description: 'true 表示生成后发送；默认仅生成供试听或后续使用。' },
      target: { type: 'string', description: '省略回复当前QQ；跨会话发送使用zeta_conversation_list返回的target。自主联系须明确指定白名单目标。群号不能替代group_openid。' },
    }, required: ['text'], additionalProperties: false },
    output: { schema: { type: 'object' }, render: (_args: unknown, value: SpeechResult) => [{ type: 'text', text:
      `语音已生成：${value.filePath}\n服务：${value.provider}，声线：${value.voice}，${value.bytes}字节。\n发送状态：${value.delivery === 'sent' ? '已发送' : value.delivery === 'not_requested' ? '未请求发送' : value.delivery === 'failed' ? '失败' : '未知，未自动重发'}${value.notice ? `\n${value.notice}` : ''}` }] },
    execute: async (args: unknown, exec: ModuleExecution): Promise<SpeechResult> => generateSpeech(host, await getSettings(), args, exec, options),
  });
}
