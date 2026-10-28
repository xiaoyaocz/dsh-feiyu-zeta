import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { legacyMaterialOwner, materialActorKey, migratedOperationId } from "./shared-materials.js";
export const SPEECH_TOOL_NAME = 'zeta_speech_generate';
export const SPEECH_LIST_TOOL_NAME = 'zeta_speech_list';
export const SPEECH_SEND_TOOL_NAME = 'zeta_speech_send';
export const SPEECH_ENDPOINTS = {
    mimo: 'https://api.xiaomimimo.com/v1/chat/completions',
    minimax: 'https://api.minimax.cn/v1/t2a_v2',
};
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 36 * 1024 * 1024;
const MAX_TEXT_CHARACTERS = 5000;
const MAX_MANIFEST_CHARACTERS = 65536;
const EMOTIONS = ['auto', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent', 'whisper'];
export class SpeechError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'SpeechError';
    }
}
const running = new Map();
const deliveryQueues = new Map();
const digest = (value) => createHash('sha256').update(value).digest('hex');
function cancelled(signal) {
    if (signal.aborted)
        throw new SpeechError('ABORTED', '语音操作已取消；已提交的请求不会自动重发。');
}
function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value : undefined;
}
function plainString(value, name, max) {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new SpeechError('INVALID_ARGUMENT', `${name}无效。`);
    }
    return value.trim();
}
export function validateSpeechArguments(value, settings) {
    const args = object(value);
    if (!args || Object.keys(args).some(key => !['text', 'provider', 'voice', 'speed', 'emotion', 'send', 'target'].includes(key))) {
        throw new SpeechError('INVALID_ARGUMENT', '语音参数无效。');
    }
    if (typeof args.text !== 'string' || !args.text.trim())
        throw new SpeechError('INVALID_ARGUMENT', '需要实际朗读文本。');
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
    if (args.send !== undefined && typeof args.send !== 'boolean')
        throw new SpeechError('INVALID_ARGUMENT', 'send 必须为布尔值。');
    if (args.speed !== undefined && (typeof args.speed !== 'number' || !Number.isFinite(args.speed) || args.speed < 0.5 || args.speed > 2)) {
        throw new SpeechError('INVALID_ARGUMENT', '语速须为 0.5–2。');
    }
    const target = args.target === undefined ? undefined : plainString(args.target, '发送目标', 300);
    if (target && !/^(c2c|group):[^\s:]+$/u.test(target))
        throw new SpeechError('INVALID_ARGUMENT', '发送目标格式应为 c2c:用户ID 或 group:群ID。');
    if (target && args.send !== true)
        throw new SpeechError('INVALID_ARGUMENT', '只有请求发送时才能指定目标。');
    if (args.send === true && !target)
        throw new SpeechError('TARGET_REQUIRED', '发送语音必须明确提供target。先查zeta_conversation_list取得真实群聊或私聊目标；不会默认发回当前聊天，也不会先生成收费语音。');
    return {
        text,
        ...(args.provider === undefined ? {} : { provider: args.provider }),
        ...(args.voice === undefined ? {} : { voice: plainString(args.voice, '声线', 256) }),
        ...(args.speed === undefined ? {} : { speed: args.speed }),
        ...(args.emotion === undefined ? {} : { emotion: plainString(args.emotion, '情绪', 32) }),
        ...(args.send === undefined ? {} : { send: args.send }),
        ...(target === undefined ? {} : { target }),
    };
}
function resolvedRequest(args, settings) {
    if (!settings.enabled)
        throw new SpeechError('DISABLED', '语音生成已关闭。');
    const provider = args.provider ?? settings.provider;
    if (provider !== 'mimo' && provider !== 'minimax')
        throw new SpeechError('INVALID_CONFIGURATION', '语音服务配置无效。');
    const config = settings[provider];
    if (!config)
        throw new SpeechError('INVALID_CONFIGURATION', '语音服务配置缺失。');
    const model = plainString(config.model, '语音模型', 100);
    const voice = plainString(args.voice ?? config.voice, '声线', 256);
    const speed = args.speed ?? config.speed;
    const emotion = args.emotion ?? (config.emotion || undefined);
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 2)
        throw new SpeechError('INVALID_CONFIGURATION', '语速须为 0.5–2。');
    if (!Number.isInteger(settings.timeoutMs) || settings.timeoutMs < 1000 || settings.timeoutMs > 180000) {
        throw new SpeechError('INVALID_CONFIGURATION', '语音超时须为 1000–180000 毫秒。');
    }
    if (provider === 'mimo') {
        if (model !== 'mimo-v2.5-tts')
            throw new SpeechError('INVALID_CONFIGURATION', '首版 MiMo 语音仅支持 mimo-v2.5-tts 预置声线模型。');
        if (emotion && emotion !== 'auto')
            throw new SpeechError('INVALID_ARGUMENT', 'MiMo 不接受 MiniMax 的 emotion 参数。');
    }
    else {
        if (!/^speech-[A-Za-z0-9][A-Za-z0-9._-]{0,78}$/u.test(model))
            throw new SpeechError('INVALID_CONFIGURATION', 'MiniMax Speech 模型配置无效。');
        if (emotion && !EMOTIONS.includes(emotion))
            throw new SpeechError('INVALID_ARGUMENT', 'MiniMax 情绪参数无效。');
        if (emotion && ['fluent', 'whisper'].includes(emotion) && !model.startsWith('speech-2.6-')) {
            throw new SpeechError('INVALID_ARGUMENT', '当前 MiniMax 模型不支持该情绪参数。');
        }
    }
    return { provider, text: args.text, model, voice, speed, ...(emotion ? { emotion } : {}), timeoutMs: settings.timeoutMs };
}
async function readJson(response, signal) {
    if (!response.ok) {
        await response.body?.cancel().catch(() => { });
        throw new SpeechError(response.status >= 400 && response.status < 500 && response.status !== 408 ? 'REJECTED' : 'UNKNOWN', `语音服务请求未成功（HTTP ${response.status}）；未自动重新提交。`);
    }
    if (!response.body)
        throw new SpeechError('UNKNOWN', '语音服务响应为空；未自动重新提交。');
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        await response.body.cancel().catch(() => { });
        throw new SpeechError('INVALID_RESPONSE', '语音服务响应超过大小上限。');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    const onAbort = () => { void reader.cancel().catch(() => { }); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
        for (;;) {
            cancelled(signal);
            const next = await reader.read();
            cancelled(signal);
            if (next.done)
                break;
            size += next.value.byteLength;
            if (size > MAX_RESPONSE_BYTES) {
                await reader.cancel().catch(() => { });
                throw new SpeechError('INVALID_RESPONSE', '语音服务响应超过大小上限。');
            }
            chunks.push(next.value);
        }
    }
    finally {
        signal.removeEventListener('abort', onAbort);
        reader.releaseLock();
    }
    let result;
    try {
        result = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    }
    catch { /* Never echo response bodies. */ }
    if (!result)
        throw new SpeechError('INVALID_RESPONSE', '语音服务返回了无效数据。');
    return result;
}
function decodeAudio(value, encoding) {
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
export async function synthesizeSpeech(request, signal, requestFetch = fetch) {
    cancelled(signal);
    // The management preview can call this adapter directly, so it has the same
    // bounds as model tool execution rather than trusting a particular caller.
    const directSettings = {
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
        if (!Number.isInteger(base?.status_code))
            throw new SpeechError('INVALID_RESPONSE', 'MiniMax 响应缺少服务状态。');
        if (base?.status_code !== 0)
            throw new SpeechError('REJECTED', `MiniMax 拒绝语音请求（服务码 ${base?.status_code}）。`);
        const data = object(result.data);
        if (data?.status !== 2)
            throw new SpeechError('INVALID_RESPONSE', 'MiniMax 未完整完成语音合成。');
        return { audio: decodeAudio(data.audio, 'hex'), mimeType: 'audio/wav',
            ...(typeof result.trace_id === 'string' ? { providerRequestId: result.trace_id.slice(0, 128) } : {}) };
    }
    catch (error) {
        if (combined.aborted)
            throw new SpeechError(signal.aborted ? 'ABORTED' : 'TIMEOUT', '语音请求已取消或超时，服务端结果可能未知；未自动重新提交。');
        if (error instanceof SpeechError)
            throw error;
        throw new SpeechError('UNKNOWN', '语音服务连接失败，结果可能未知；未自动重新提交。');
    }
}
async function readManifest(path) {
    try {
        const data = await readFile(path, 'utf8');
        if (data.length > MAX_MANIFEST_CHARACTERS)
            throw new Error();
        const value = object(JSON.parse(data));
        if (value?.version !== 1 || typeof value.fingerprint !== 'string')
            throw new Error();
        return value;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw new SpeechError('LOCAL_STATE', '已有语音记录无法读取，未重新发起收费请求。');
    }
}
async function saveManifest(path, value) {
    const serialized = JSON.stringify(value);
    // Never replace a readable receipt with an oversized record. In particular, a
    // full delivery ledger must fail before the next external send can begin.
    if (serialized.length > MAX_MANIFEST_CHARACTERS)
        throw new SpeechError('LOCAL_STATE', '语音投递记录超过大小上限，已保留原记录；不会自动重新生成或发送。');
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, serialized, { mode: 0o600 });
    await rename(temporary, path);
}
function safeReceipt(value) {
    // Keep platform evidence, not arbitrary SDK transport/configuration objects.
    const result = {};
    for (const key of ['status', 'outcome', 'messageId', 'fileUuid', 'target', 'fileName', 'fileSize', 'size', 'reused']) {
        const item = value[key];
        if (typeof item === 'string')
            result[key] = item.slice(0, 1024);
        else if (typeof item === 'number' && Number.isFinite(item))
            result[key] = item;
        else if (typeof item === 'boolean' || item === null)
            result[key] = item;
    }
    return result;
}
function assertScope(host, agent) {
    if (!host.bindingFor(agent) && !host.isLifeAgent(agent))
        throw new SpeechError('NO_SCOPE', '当前会话尚未关联 dsh-feiyu-zeta，不能生成或读取语音。');
}
function synthesisFingerprint(request) {
    return digest(JSON.stringify({ provider: request.provider, model: request.model, text: request.text, voice: request.voice, speed: request.speed,
        ...(request.emotion && request.emotion !== 'auto' ? { emotion: request.emotion } : {}) }));
}
function actualTarget(result) {
    const value = result.target ?? result.receipt?.target;
    return typeof value === 'string' && /^(c2c|group):[^\s:]+$/u.test(value) ? value : undefined;
}
function deliveryResult(base, delivery, reused = false) {
    const { receipt: _receipt, target: _target, requestedTarget: _requestedTarget, notice: _notice, reused: _reused, ...audio } = base;
    const status = delivery.delivery === 'pending' ? 'unknown' : delivery.delivery;
    return { ...audio, delivery: status, requestedTarget: delivery.requestedTarget, ...(delivery.target ? { target: delivery.target } : {}),
        ...(delivery.receipt ? { receipt: delivery.receipt } : {}), ...(reused || delivery.receipt?.reused === true ? { reused: true } : {}),
        ...(status === 'sent' ? { notice: `本次请求已发送至${delivery.target}，不要重复发送；用户之后明确要求再次发送时，使用zeta_speech_send复用此音频。` }
            : { notice: delivery.notice ?? '此前发送结果未确认，不会自动重新发送；请先核对QQ中的实际结果。' }) };
}
function reusedResult(result) {
    const target = actualTarget(result);
    return { ...result, ...(target ? { target } : {}), reused: true,
        notice: result.delivery === 'sent' ? `该语音已经${target ? `发送至${target}` : '发送（旧记录未保留实际目标）'}，不要重复生成或发送。`
            : result.delivery === 'not_requested' ? '已复用生成的音频，没有再次收费；尚未发送。需要发送时用zeta_speech_send并明确target。' : result.notice ?? '此前发送结果未确认，不会自动重发。' };
}
async function checkedAudio(manifest, filePath, fileName) {
    if (manifest.state !== 'completed' || !manifest.result)
        throw new SpeechError('OUTCOME_UNKNOWN', '此前语音请求未确认完成，不会自动重新生成；请检查语音记录。');
    let audio;
    try {
        audio = await readFile(filePath);
    }
    catch {
        throw new SpeechError('LOCAL_STATE', '已生成语音文件不可用，未重新发起收费请求。');
    }
    if (manifest.sha256 !== digest(audio) || audio.length < 12 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE')
        throw new SpeechError('LOCAL_STATE', '已生成语音校验失败，未重新发起收费请求。');
    return { ...manifest.result, filePath, fileName, ...(actualTarget(manifest.result) ? { target: actualTarget(manifest.result) } : {}),
        ...(manifest.delivery === 'pending' || manifest.delivery === 'unknown' ? { delivery: 'unknown', notice: '此前发送结果未知，未自动重发。' } : {}) };
}
async function deliverStoredSpeech(host, manifestPath, filePath, fileName, target, exec, reused) {
    // A new real inbound request may deliberately resend the same audio. Model call ids
    // within one request never authorize another delivery, including an unknown outcome.
    const requestKey = host.requestKeyFor?.(exec.agent);
    const deliveryKey = requestKey ? `request:${digest(requestKey)}:${target}` : target;
    const prior = deliveryQueues.get(manifestPath) ?? Promise.resolve();
    const task = prior.catch(() => { }).then(async () => {
        cancelled(exec.signal);
        host.requireWritable?.();
        const manifest = await readManifest(manifestPath);
        if (!manifest)
            throw new SpeechError('LOCAL_STATE', '语音记录不存在，请先用zeta_speech_list查询已有音频。');
        const base = await checkedAudio(manifest, filePath, fileName);
        const knownTarget = manifest.result?.requestedTarget ?? actualTarget(base);
        const previous = manifest.deliveries?.[deliveryKey] ?? (!requestKey && manifest.delivery !== 'not_requested' && knownTarget === target
            ? { delivery: manifest.delivery, requestedTarget: target, ...(actualTarget(base) ? { target: actualTarget(base) } : {}), ...(base.receipt ? { receipt: base.receipt } : {}) } : undefined);
        if (previous)
            return deliveryResult(base, previous, true);
        if (!requestKey && manifest.delivery !== 'not_requested' && !knownTarget && !manifest.deliveries)
            return reusedResult({ ...base, delivery: 'unknown', notice: '旧语音记录没有保存发送目标，不能安全地自动重发。请先核对QQ中的实际结果。' });
        host.validateSendTarget?.(exec.agent, target, 'speech');
        cancelled(exec.signal);
        manifest.deliveries = { ...manifest.deliveries, [deliveryKey]: { delivery: 'pending', requestedTarget: target, ...(requestKey ? { requestKey } : {}) } };
        manifest.delivery = 'pending';
        manifest.result = deliveryResult(base, manifest.deliveries[deliveryKey]);
        await saveManifest(manifestPath, manifest);
        let delivery;
        try {
            cancelled(exec.signal);
            const receipt = safeReceipt(await host.sendFile(exec.agent, filePath, target, exec.signal));
            const confirmedTarget = typeof receipt.target === 'string' && /^(c2c|group):[^\s:]+$/u.test(receipt.target) ? receipt.target : undefined;
            const status = receipt.outcome === 'failed' || receipt.status === 'failed' ? 'failed'
                : receipt.outcome === 'unknown' || receipt.status === 'unknown' || confirmedTarget !== target ? 'unknown'
                    : receipt.outcome === 'sent' || receipt.status === 'accepted' || receipt.status === 'sent' || typeof receipt.messageId === 'string' && receipt.messageId.length > 0 ? 'sent' : 'unknown';
            delivery = { delivery: status, requestedTarget: target, ...(requestKey ? { requestKey } : {}), ...(confirmedTarget ? { target: confirmedTarget } : {}), receipt,
                ...(status === 'unknown' ? { notice: '语音已生成，但QQ回执未同时确认发送结果和实际目标；未自动重发。' } : {}) };
        }
        catch {
            delivery = { delivery: 'unknown', requestedTarget: target, ...(requestKey ? { requestKey } : {}), notice: '语音已生成，但发送结果未确认；未自动重发。' };
        }
        const result = deliveryResult(base, delivery, reused);
        manifest.deliveries[deliveryKey] = delivery;
        manifest.delivery = delivery.delivery;
        manifest.result = result;
        await saveManifest(manifestPath, manifest);
        return result;
    });
    deliveryQueues.set(manifestPath, task);
    try {
        return await task;
    }
    finally {
        if (deliveryQueues.get(manifestPath) === task)
            deliveryQueues.delete(manifestPath);
    }
}
/** Send a verified library file without another provider request or credential read. */
export async function sendSpeech(host, input, exec) {
    cancelled(exec.signal);
    assertScope(host, exec.agent);
    host.requireWritable?.();
    const args = object(input);
    if (!args || Object.keys(args).some(key => !['fileName', 'target'].includes(key)) || typeof args.fileName !== 'string' || !/^speech-[a-f0-9]{40}\.wav$/u.test(args.fileName))
        throw new SpeechError('INVALID_ARGUMENT', '请使用zeta_speech_list返回的fileName，不接受任意文件路径。');
    const target = args.target === undefined ? undefined : plainString(args.target, '发送目标', 300);
    if (!target)
        throw new SpeechError('TARGET_REQUIRED', '复用语音发送必须明确target，请先查询真实会话目标。');
    if (!/^(c2c|group):[^\s:]+$/u.test(target))
        throw new SpeechError('INVALID_ARGUMENT', '发送目标格式应为 c2c:用户ID 或 group:群ID。');
    const directory = await host.directoryFor(exec.agent, 'speech');
    if (!isAbsolute(directory))
        throw new SpeechError('LOCAL_STATE', '语音目录必须是宿主提供的绝对路径。');
    return deliverStoredSpeech(host, join(directory, args.fileName.replace(/\.wav$/u, '.json')), join(directory, args.fileName), args.fileName, target, exec, true);
}
/** Request-scoped synthesis identity prevents repeated charges across model call ids. */
export async function generateSpeech(host, settings, input, exec, options = {}) {
    cancelled(exec.signal);
    const args = validateSpeechArguments(input, settings);
    const request = resolvedRequest(args, settings);
    assertScope(host, exec.agent);
    const directory = await host.directoryFor(exec.agent, 'speech');
    if (!isAbsolute(directory))
        throw new SpeechError('LOCAL_STATE', '语音目录必须是宿主提供的绝对路径。');
    await mkdir(directory, { recursive: true });
    const actorKey = materialActorKey(host, exec.agent), callId = exec.callId || randomUUID();
    const requestKey = host.requestKeyFor?.(exec.agent);
    const generationFingerprint = synthesisFingerprint(request);
    const fingerprint = digest(JSON.stringify({ ...request, send: args.send === true, target: args.target ?? null }));
    const legacy = await migratedOperationId(host.dataDir, 'speech', legacyMaterialOwner(host, exec.agent), digest(callId).slice(0, 40));
    const oldOperation = legacy ?? digest(`${actorKey}:${callId}`).slice(0, 40);
    let operation = requestKey ? digest(`${actorKey}:request:${requestKey}:tts:${generationFingerprint}`).slice(0, 40) : oldOperation;
    // A pre-upgrade invocation is authoritative even when the caller now has a request key.
    // Never abandon its pending/outcome-unknown record and charge again under the new identity.
    if (operation !== oldOperation && await readManifest(join(directory, `speech-${oldOperation}.json`)))
        operation = oldOperation;
    cancelled(exec.signal);
    host.requireWritable?.();
    const fileName = `speech-${operation}.wav`, filePath = join(directory, fileName), manifestPath = join(directory, `speech-${operation}.json`);
    const perform = async () => {
        cancelled(exec.signal);
        let manifest = await readManifest(manifestPath);
        if (manifest) {
            const semantic = !!requestKey && !!manifest.generationFingerprint;
            if (semantic ? manifest.generationFingerprint !== generationFingerprint : manifest.fingerprint !== fingerprint)
                throw new SpeechError('CALL_CONFLICT', '同一调用标识对应不同语音参数。');
            const result = await checkedAudio(manifest, filePath, fileName);
            if (!args.send)
                return reusedResult(result);
            const knownTarget = result.requestedTarget ?? actualTarget(result);
            const recordedTarget = Object.values(manifest.deliveries ?? {}).some(value => value.requestedTarget === args.target && value.requestKey === requestKey);
            if (manifest.delivery !== 'not_requested' && knownTarget && knownTarget !== args.target && !recordedTarget)
                throw new SpeechError('TARGET_CONFLICT', `这段语音已有${knownTarget}的发送记录，不能把原回执当成发往${args.target}。请用zeta_speech_send和此fileName明确复用发送，不要重新生成。`);
            // Old call-id records remain authoritative after upgrading the host. Replaying
            // generation cannot reinterpret a prior delivery as a new send authorization.
            if (!manifest.requestKey && requestKey && manifest.delivery !== 'not_requested')
                return reusedResult(result);
            return deliverStoredSpeech(host, manifestPath, filePath, fileName, args.target, exec, true);
        }
        // Both the target preflight and the autonomous cost gate must finish before a credential
        // is resolved or a provider request is submitted. No implicit current-chat destination.
        if (args.send)
            host.validateSendTarget?.(exec.agent, args.target, 'speech');
        await options.beforeGenerate?.(args, exec);
        cancelled(exec.signal);
        host.requireWritable?.();
        let apiKey;
        try {
            apiKey = await host.resolveApiKey(request.provider);
        }
        catch {
            throw new SpeechError('NO_CREDENTIAL', '无法读取所选语音服务的密钥。');
        }
        if (!apiKey?.trim())
            throw new SpeechError('NO_CREDENTIAL', '尚未配置所选语音服务的密钥。');
        cancelled(exec.signal);
        manifest = { version: 1, actorKey, fingerprint, generationFingerprint, ...(requestKey ? { requestKey } : {}), state: 'pending', delivery: 'not_requested' };
        try {
            await writeFile(manifestPath, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
        }
        catch {
            throw new SpeechError('LOCAL_STATE', '语音调用记录已存在或无法写入，未发起请求。');
        }
        let result;
        try {
            const response = await synthesizeSpeech({ ...request, apiKey }, exec.signal, options.fetch);
            cancelled(exec.signal);
            await writeFile(filePath, response.audio, { flag: 'wx', mode: 0o600 });
            result = { provider: request.provider, model: request.model, voice: request.voice, filePath, fileName,
                mimeType: response.mimeType, bytes: response.audio.length, characters: Array.from(args.text).length,
                createdAt: new Date().toISOString(), generation: 'completed', delivery: 'not_requested' };
            manifest = { ...manifest, state: 'completed', result, sha256: digest(response.audio) };
            await saveManifest(manifestPath, manifest);
        }
        catch (error) {
            manifest.state = error instanceof SpeechError && error.code === 'REJECTED' ? 'failed' : 'unknown';
            manifest.errorCode = error instanceof SpeechError ? error.code : 'LOCAL_STATE';
            await saveManifest(manifestPath, manifest).catch(() => { });
            if (error instanceof SpeechError)
                throw error;
            throw new SpeechError('LOCAL_STATE', '语音结果未能完整保存；不会自动重新生成。');
        }
        return args.send ? deliverStoredSpeech(host, manifestPath, filePath, fileName, args.target, exec, false) : result;
    };
    const active = running.get(manifestPath);
    if (active) {
        if (active.generationFingerprint !== generationFingerprint || !requestKey && active.fingerprint !== fingerprint)
            throw new SpeechError('CALL_CONFLICT', '同一调用标识对应不同语音参数。');
        await active.promise;
        cancelled(exec.signal);
        return perform();
    }
    const promise = perform();
    running.set(manifestPath, { fingerprint, generationFingerprint, promise });
    try {
        return await promise;
    }
    finally {
        if (running.get(manifestPath)?.promise === promise)
            running.delete(manifestPath);
    }
}
/** Read-only metadata for the authenticated management UI, scoped by the host. */
export async function listSpeechFiles(host, agent, limit = 20) {
    if (!host.bindingFor(agent) && !host.isLifeAgent(agent))
        throw new SpeechError('NO_SCOPE', '当前会话尚未关联 dsh-feiyu-zeta。');
    const { readdir } = await import('node:fs/promises');
    const directory = await host.directoryFor(agent, 'speech');
    const count = Math.max(1, Math.min(100, Number.isInteger(limit) ? limit : 20));
    let names;
    try {
        names = await readdir(directory);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
    const values = [];
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
export function registerSpeechTools(host, getSettings, options = {}) {
    const tools = host.ctx.get('tools');
    if (!tools?.register)
        throw new SpeechError('NO_TOOLS', 'DSH 工具服务未就绪。');
    tools.register({
        name: SPEECH_TOOL_NAME,
        description: '生成真实WAV语音；send:true时必须明确target，发群前先查zeta_conversation_list取得真实group目标，绝不默认回当前私聊。生成成功不代表已发送。同一请求同内容复用音频；已有语音请用zeta_speech_list和zeta_speech_send发送，不能反复生成收费。',
        parameters: { type: 'object', properties: {
                text: { type: 'string', description: '需要朗读的实际文本。' },
                provider: { type: 'string', enum: ['mimo', 'minimax'], description: '省略时使用配置的默认语音服务。' },
                voice: { type: 'string', description: '可选的服务声线 ID。' },
                speed: { type: 'number', minimum: 0.5, maximum: 2, description: '语速；MiMo 通过朗读提示近似控制，MiniMax 使用原生参数。' },
                emotion: { type: 'string', enum: EMOTIONS, description: 'MiniMax 情绪参数；MiMo 不接受此项。' },
                send: { type: 'boolean', description: 'true 表示生成后发送；默认仅生成供试听或后续使用。' },
                target: { type: 'string', pattern: '^(c2c|group):[^\\s:]+$', description: 'send:true时必填。使用zeta_conversation_list返回的真实c2c:用户ID或group:群openid；不得省略或用当前私聊代替要求的群聊。' },
            }, required: ['text'], additionalProperties: false },
        output: { schema: { type: 'object' }, render: (_args, value) => renderSpeechResult(value) },
        execute: async (args, exec) => generateSpeech(host, await getSettings(), args, exec, options),
    });
    tools.register({
        name: SPEECH_LIST_TOOL_NAME, description: '查询已生成的共享语音与真实投递回执。用户说“发”“去群里发”时先查已有音频，再用zeta_speech_send明确target；查询不收费、不发送。',
        parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
        output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: async (args, exec) => { cancelled(exec.signal); return { items: await listSpeechFiles(host, exec.agent, args.limit) }; },
    });
    tools.register({
        name: SPEECH_SEND_TOOL_NAME, description: '发送已生成的WAV，复用原文件而不再次合成或收费。fileName取自zeta_speech_list，target必须明确来自会话目录。同一请求内已确认或结果未知的同目标发送不会重复；用户下一条明确要求再次发送时可复用发送，只根据真实回执报告已发到哪里。',
        parameters: { type: 'object', properties: { fileName: { type: 'string', pattern: '^speech-[a-f0-9]{40}\\.wav$' }, target: { type: 'string', pattern: '^(c2c|group):[^\\s:]+$' } }, required: ['fileName', 'target'], additionalProperties: false },
        output: { schema: { type: 'object' }, render: (_args, value) => renderSpeechResult(value) },
        execute: (args, exec) => sendSpeech(host, args, exec),
    });
}
function renderSpeechResult(value) {
    const target = actualTarget(value);
    return [{ type: 'text', text: `生成状态：已完成${value.reused ? '（复用已有音频，没有再次收费）' : ''}。\nfileName：${value.fileName}\n音频：${value.filePath}\n服务：${value.provider}，声线：${value.voice}，${value.bytes}字节。\n发送状态：${value.delivery === 'sent' ? `已发送；实际目标：${target ?? '旧记录未保留，勿猜测'}` : value.delivery === 'not_requested' ? '未请求发送；尚未发送到任何QQ目标' : value.delivery === 'failed' ? '发送失败' : '发送结果未知，未自动重发'}${value.requestedTarget ? `\n请求目标：${value.requestedTarget}` : ''}${value.notice ? `\n${value.notice}` : ''}` }];
}
//# sourceMappingURL=speech.js.map