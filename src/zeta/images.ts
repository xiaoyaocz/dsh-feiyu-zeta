import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ModuleExecution } from './contracts.ts';
import { atomicJson, boundedBytes, publicHttpUrl, readServiceJson, registerServiceTool, responseObject,
  scopeFor, ServiceError, serviceAbort, serviceHash, serviceObject, type ExternalModuleHost } from './browser.ts';
import { imageMime, type PersonaService } from './persona.ts';
import { legacyMaterialOwner, materialActorKey, migratedOperationId } from './shared-materials.ts';

export interface ImageSettings {
  enabled: boolean; model: string; resolution: '1K' | '2K' | '4K'; timeoutMs: number; pollIntervalMs: number;
  maxWaitMs: number; maxPromptCharacters: number; maxImageBytes: number; dailyLimit: number;
}
export const DEFAULT_IMAGE_SETTINGS: ImageSettings = { enabled: false, model: 'gemini-nano-banana-2.1-ext', resolution: '1K',
  timeoutMs: 30000, pollIntervalMs: 4000, maxWaitMs: 300000, maxPromptCharacters: 8000, maxImageBytes: 20 * 1024 * 1024, dailyLimit: 10 };
export interface ImageInput { prompt: string; size?: string; selfPortrait?: boolean; referenceUrls?: string[]; send?: boolean; target?: string; wait?: boolean }
export interface ImageResult {
  id: string; taskId?: string; status: 'submitting' | 'unknown' | 'pending' | 'processing' | 'completed' | 'failed';
  model: string; resolution: string; createdAt: string; selfPortrait: boolean; filePath?: string; mimeType?: string; bytes?: number;
  delivery: 'not_requested' | 'pending' | 'sent' | 'failed' | 'unknown'; cost?: number; notice?: string;
}
interface ImageRecord extends ImageResult { version: 1; owner: string; actorKey?: string; fingerprint: string; sha256?: string; send: boolean; target?: string }
export interface ImageOptions {
  fetch?: typeof fetch;
  beforeGenerate?: (input: ImageInput, exec: ModuleExecution) => void | Promise<void>;
}
const RATIOS = ['auto', '1:4', '4:1', '1:8', '8:1', '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
export class ImageService {
  private readonly requestFetch: typeof fetch;
  private readonly running = new Map<string, Promise<ImageResult>>();
  private readonly controllers = new Set<AbortController>();
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  constructor(readonly host: ExternalModuleHost, readonly getSettings: () => ImageSettings | Promise<ImageSettings>,
    readonly persona: PersonaService, readonly options: ImageOptions = {}) { this.requestFetch = options.fetch ?? fetch; }
  private get root(): string { return join(this.host.dataDir, 'images'); }
  private directory(owner: string): string { return join(this.root, serviceHash(owner).slice(0, 32)); }
  private path(owner: string, id: string): string {
    if (!/^[a-f0-9]{40}$/u.test(id)) throw new ServiceError('INVALID_ARGUMENT', '图片任务标识无效。');
    return join(this.directory(owner), `${id}.json`);
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const task = this.queue.then(run); this.queue = task.catch(() => {}); return task;
  }
  private public(record: ImageRecord): ImageResult {
    const { version: _version, owner: _owner, actorKey: _actor, fingerprint: _fingerprint, sha256: _sha, send: _send, target: _target, ...value } = record;
    return { ...value, ...(value.delivery === 'pending' ? { delivery: 'unknown' as const, notice: '此前发送结果未确认，不会自动重发。' } : {}) };
  }
  private async settings(): Promise<ImageSettings> {
    const settings = await this.getSettings();
    if (!settings.enabled) throw new ServiceError('DISABLED', '图像生成已关闭。');
    if (settings.model !== 'gemini-nano-banana-2.1-ext' || !['1K', '2K', '4K'].includes(settings.resolution)) throw new ServiceError('INVALID_CONFIGURATION', '图像模型或分辨率配置无效。');
    for (const [value, min, max] of [[settings.timeoutMs, 1000, 120000], [settings.pollIntervalMs, 1000, 30000],
      [settings.maxWaitMs, 1000, 600000], [settings.maxPromptCharacters, 1, 20000], [settings.maxImageBytes, 1024, 20 * 1024 * 1024], [settings.dailyLimit, 1, 1000]]) {
      if (!Number.isInteger(value) || value! < min! || value! > max!) throw new ServiceError('INVALID_CONFIGURATION', '图像限额配置无效。');
    }
    return settings;
  }
  private validate(input: ImageInput, settings: ImageSettings): ImageInput {
    if (!input || Object.keys(input).some(key => !['prompt', 'size', 'selfPortrait', 'referenceUrls', 'send', 'target', 'wait'].includes(key)) ||
      typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > settings.maxPromptCharacters || input.prompt.includes('\u0000')) throw new ServiceError('INVALID_ARGUMENT', '图片提示词无效或过长。');
    if (input.size !== undefined && !RATIOS.includes(input.size)) throw new ServiceError('INVALID_ARGUMENT', '图片宽高比无效。');
    for (const key of ['selfPortrait', 'send', 'wait'] as const) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new ServiceError('INVALID_ARGUMENT', '图片选项无效。');
    if (input.referenceUrls !== undefined && (!Array.isArray(input.referenceUrls) || input.referenceUrls.length > 3)) throw new ServiceError('INVALID_ARGUMENT', '最多提供三张额外公开参考图。');
    input.referenceUrls?.forEach(publicHttpUrl);
    if (input.target !== undefined && (input.send !== true || typeof input.target !== 'string' || !/^(c2c|group):[^\s:]{1,256}$/u.test(input.target))) throw new ServiceError('INVALID_ARGUMENT', '图片发送目标无效。');
    return { ...input, prompt: input.prompt.trim(), selfPortrait: input.selfPortrait === true || /自画像|你自己|你的样子|self[- ]?portrait/iu.test(input.prompt) };
  }
  private async key(): Promise<string> {
    try { const value = await this.host.resolveServiceKey('apimart'); if (value?.trim()) return value; } catch { /* Do not echo credential errors. */ }
    throw new ServiceError('NO_CREDENTIAL', '尚未配置 ApiMart 密钥。');
  }
  private async reserve(settings: ImageSettings): Promise<void> {
    await this.serial(async () => {
      await mkdir(this.root, { recursive: true });
      const path = join(this.root, 'usage.json');
      const day = new Date().toISOString().slice(0, 10);
      const ledger = await readServiceJson<{ day: string; count: number }>(path) ?? { day, count: 0 };
      const count = ledger.day === day ? ledger.count : 0;
      if (!Number.isSafeInteger(count) || count < 0) throw new ServiceError('LOCAL_STATE', '生图预算记录无效。');
      if (count >= settings.dailyLimit) throw new ServiceError('BUDGET', '今日图片提交次数已达上限。');
      await atomicJson(path, { day, count: count + 1 });
    });
  }
  private async load(owner: string, id: string): Promise<ImageRecord | undefined> {
    const value = await readServiceJson<ImageRecord>(this.path(owner, id));
    if (value && (value.version !== 1 || value.owner !== owner || value.id !== id)) throw new ServiceError('LOCAL_STATE', '图片任务记录无效。');
    if (value?.status === 'completed') {
      const extension = value.mimeType === 'image/png' ? 'png' : value.mimeType === 'image/jpeg' ? 'jpg' : value.mimeType === 'image/webp' ? 'webp' : undefined;
      if (!extension) throw new ServiceError('LOCAL_STATE', '图片文件类型记录无效。');
      value.filePath = join(this.directory(owner), `${id}.${extension}`);
    }
    return value;
  }
  async generate(raw: ImageInput, exec: ModuleExecution): Promise<ImageResult> {
    serviceAbort(exec.signal);
    if (this.stopped) throw new ServiceError('STOPPED', '图像服务已停止。');
    const owner = scopeFor(this.host, exec.agent);
    const settings = await this.settings();
    const input = this.validate(raw, settings);
    await this.options.beforeGenerate?.(input, exec);
    this.host.requireWritable?.();
    if (this.stopped) throw new ServiceError('STOPPED', '图像服务已停止。');
    const persona = input.selfPortrait ? await this.persona.get() : undefined;
    if (input.selfPortrait && !persona) throw new ServiceError('NO_PERSONA', '尚未上传人设图，不能按人设生成自画像。');
    serviceAbort(exec.signal); this.host.requireWritable?.();
    const fingerprint = serviceHash(JSON.stringify({ ...input, wait: undefined, model: settings.model, resolution: settings.resolution, persona: persona?.id }));
    const actorKey = materialActorKey(this.host, exec.agent);
    const callId = exec.callId || randomUUID();
    const id = await migratedOperationId(this.host.dataDir, 'images', legacyMaterialOwner(this.host, exec.agent), serviceHash(callId).slice(0, 40)) ?? serviceHash(`${actorKey}:${callId}`).slice(0, 40);
    serviceAbort(exec.signal); this.host.requireWritable?.();
    const operation = `${owner}:${id}`;
    const active = this.running.get(operation);
    if (active) { const result = await active; const record = await this.load(owner, id); if (record?.fingerprint !== fingerprint) throw new ServiceError('CALL_CONFLICT', '相同调用标识对应不同生图参数。'); return result; }
    const promise = this.generateOnce(owner, id, fingerprint, input, settings, exec);
    this.running.set(operation, promise);
    try { return await promise; } finally { if (this.running.get(operation) === promise) this.running.delete(operation); }
  }
  private async generateOnce(owner: string, id: string, fingerprint: string, input: ImageInput, settings: ImageSettings, exec: ModuleExecution): Promise<ImageResult> {
    const controller = new AbortController(); this.controllers.add(controller);
    const signal = AbortSignal.any([exec.signal, controller.signal]);
    try {
      let record = await this.load(owner, id);
      if (record && record.fingerprint !== fingerprint) throw new ServiceError('CALL_CONFLICT', '相同调用标识对应不同生图参数。');
      if (record?.status === 'completed' || record?.status === 'failed') return this.refresh(record, settings, '', exec.agent, signal, false);
      if (record && !record.taskId) return this.public({ ...record, status: 'unknown', notice: '此前提交结果未知，不会自动重新提交。' });
      const key = await this.key();
      if (!record) {
        const reference = input.selfPortrait ? await this.persona.referenceDataUrl() : undefined;
        const imageUrls = [...(reference ? [reference] : []), ...(input.referenceUrls ?? [])];
        if (input.selfPortrait && !reference) throw new ServiceError('NO_PERSONA', '人设图已移除，请重新上传。');
        await mkdir(this.directory(owner), { recursive: true });
        serviceAbort(signal);
        record = { version: 1, owner, actorKey: materialActorKey(this.host, exec.agent), id, fingerprint, status: 'submitting', model: settings.model, resolution: settings.resolution,
          createdAt: new Date().toISOString(), selfPortrait: !!input.selfPortrait, delivery: 'not_requested', send: input.send === true, target: input.target };
        await writeFile(this.path(owner, id), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
        try { await this.reserve(settings); }
        catch (error) {
          record.status = 'failed'; record.notice = '提交前已被本地预算限制阻止，没有请求生图服务。';
          await atomicJson(this.path(owner, id), record); throw error;
        }
        try {
          const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutMs)]);
          const response = await responseObject(await this.requestFetch('https://api.apimart.ai/v1/images/generations', {
            method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model: settings.model, prompt: input.prompt, resolution: settings.resolution, n: 1,
              official_fallback: false, ...(input.size ? { size: input.size } : {}), ...(imageUrls.length ? { image_urls: imageUrls } : {}) }),
            signal: requestSignal, redirect: 'error',
          }), requestSignal);
          if (response.code !== 200 || !Array.isArray(response.data)) throw new ServiceError('INVALID_RESPONSE', 'ApiMart 未确认图片任务。');
          const first = serviceObject(response.data[0]);
          if (typeof first.task_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(first.task_id)) throw new ServiceError('INVALID_RESPONSE', 'ApiMart 未返回有效任务标识。');
          record.taskId = first.task_id; record.status = 'pending';
          await atomicJson(this.path(owner, id), record);
        } catch (error) {
          record.status = error instanceof ServiceError && error.code === 'REJECTED' ? 'failed' : 'unknown';
          record.notice = '提交结果未确认，不会自动重新提交；请查看服务商任务记录。';
          await atomicJson(this.path(owner, id), record).catch(() => {});
          if (error instanceof ServiceError) throw error;
          throw new ServiceError('OUTCOME_UNKNOWN', '图片提交结果未知，不会自动重新提交。');
        }
      }
      if (!record.taskId) return this.public({ ...record, status: 'unknown', notice: '此前提交结果未知，不会自动重新提交。' });
      return await this.refresh(record, settings, key, exec.agent, signal, input.wait !== false);
    } finally { this.controllers.delete(controller); }
  }
  private async refresh(record: ImageRecord, settings: ImageSettings, key: string, agent: unknown, signal: AbortSignal, wait: boolean): Promise<ImageResult> {
    const deadline = Date.now() + settings.maxWaitMs;
    for (;;) {
      serviceAbort(signal);
      if (record.status === 'completed') {
        if (!record.filePath || !record.sha256 || serviceHash(await readFile(record.filePath)) !== record.sha256) throw new ServiceError('LOCAL_STATE', '已生成图片不可用或校验失败，不会自动重新生成。');
        return this.public(record);
      }
      if (record.status === 'failed' || !record.taskId) return this.public(record);
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutMs)]);
      let data: Record<string, unknown>;
      try {
        const response = await responseObject(await this.requestFetch(`https://api.apimart.ai/v1/tasks/${encodeURIComponent(record.taskId)}`, {
          headers: { authorization: `Bearer ${key}` }, signal: requestSignal, redirect: 'error',
        }), requestSignal);
        if (response.code !== 200) throw new ServiceError('INVALID_RESPONSE', 'ApiMart 未返回任务状态。');
        data = serviceObject(response.data);
        if (data.id !== record.taskId) throw new ServiceError('INVALID_RESPONSE', 'ApiMart 返回了其他任务的状态。');
      } catch (error) {
        if (signal.aborted) serviceAbort(signal);
        if (error instanceof ServiceError) throw error;
        throw new ServiceError('STATUS_UNAVAILABLE', '图片状态暂时不可用；任务标识已保存，可继续查询，不会重新提交。');
      }
      if (data.status === 'failed') { record.status = 'failed'; record.notice = 'ApiMart 图片任务失败；未自动重新提交。'; }
      else if (data.status === 'completed') {
        const result = serviceObject(data.result);
        const first = Array.isArray(result.images) ? serviceObject(result.images[0]) : undefined;
        const url = Array.isArray(first?.url) ? first.url[0] : undefined;
        const download = publicHttpUrl(url);
        // Never forward the provider credential to the image host or follow unchecked redirects.
        const bytes = await this.download(download, settings.maxImageBytes, signal, settings.timeoutMs);
        const mimeType = imageMime(bytes);
        const filePath = join(this.directory(record.owner), `${record.id}.${mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : 'webp'}`);
        await writeFile(filePath, bytes, { mode: 0o600 });
        record.status = 'completed'; record.filePath = filePath; record.bytes = bytes.length; record.mimeType = mimeType; record.sha256 = serviceHash(bytes);
        if (typeof data.cost === 'number' && Number.isFinite(data.cost) && data.cost >= 0) record.cost = data.cost;
        await atomicJson(this.path(record.owner, record.id), record);
        if (record.send && record.delivery === 'not_requested' && record.actorKey === materialActorKey(this.host, agent)) {
          serviceAbort(signal);
          record.delivery = 'pending'; await atomicJson(this.path(record.owner, record.id), record);
          try {
            const receipt = await this.host.sendFile(agent, filePath, record.target, signal);
            record.delivery = receipt.outcome === 'failed' || receipt.status === 'failed' ? 'failed' :
              receipt.outcome === 'sent' || receipt.status === 'accepted' || receipt.status === 'sent' || typeof receipt.messageId === 'string' && !!receipt.messageId ? 'sent' : 'unknown';
          } catch { record.delivery = 'unknown'; record.notice = '图片已生成，QQ发送结果未确认；不会自动重发。'; }
        } else if (record.send && record.delivery === 'not_requested') {
          record.notice = '图片已生成；查询者不是任务发起会话，未自动发送。需要发送时请明确调用发送工具。';
        }
      } else if (data.status === 'pending' || data.status === 'processing' || data.status === 'submitted') record.status = data.status === 'processing' ? 'processing' : 'pending';
      else throw new ServiceError('INVALID_RESPONSE', 'ApiMart 任务状态无效。');
      await atomicJson(this.path(record.owner, record.id), record);
      if (record.status === 'completed' || record.status === 'failed' || !wait || Date.now() >= deadline) return this.public(record);
      await delay(Math.min(settings.pollIntervalMs, Math.max(1, deadline - Date.now())), undefined, { signal }).catch(() => serviceAbort(signal));
    }
  }
  private async download(url: string, maximum: number, signal: AbortSignal, timeoutMs: number): Promise<Buffer> {
    let current = publicHttpUrl(url);
    for (let redirect = 0; redirect <= 3; redirect++) {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      const response = await this.requestFetch(current, { signal: requestSignal, redirect: 'manual' });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location) throw new ServiceError('INVALID_RESPONSE', '图片下载重定向无效。');
        current = publicHttpUrl(new URL(location, current).href); continue;
      }
      return boundedBytes(response, maximum, requestSignal);
    }
    throw new ServiceError('INVALID_RESPONSE', '图片下载重定向次数过多。');
  }
  async status(id: string, exec: ModuleExecution, wait = false): Promise<ImageResult> {
    serviceAbort(exec.signal);
    this.host.requireWritable?.();
    if (this.stopped) throw new ServiceError('STOPPED', '图像服务已停止。');
    const owner = scopeFor(this.host, exec.agent);
    const canonical = id.startsWith('public:');
    if (canonical) id = id.slice('public:'.length);
    this.path(owner, id);
    if (!canonical) id = await migratedOperationId(this.host.dataDir, 'images', legacyMaterialOwner(this.host, exec.agent), id) ?? id;
    serviceAbort(exec.signal); this.host.requireWritable?.();
    const record = await this.load(owner, id);
    if (!record) throw new ServiceError('NOT_FOUND', '当前对话没有此图片任务。');
    serviceAbort(exec.signal); this.host.requireWritable?.();
    const operation = `${owner}:${id}`;
    const active = this.running.get(operation);
    if (active) return active;
    const settings = await this.settings();
    const key = record.status === 'completed' || record.status === 'failed' || !record.taskId ? '' : await this.key();
    serviceAbort(exec.signal); this.host.requireWritable?.();
    const current = this.running.get(operation);
    if (current) return current;
    const controller = new AbortController(); this.controllers.add(controller);
    const signal = AbortSignal.any([exec.signal, controller.signal]);
    const promise = this.refresh(record, settings, key, exec.agent, signal, wait);
    this.running.set(operation, promise);
    try { return await promise; } finally { this.controllers.delete(controller); if (this.running.get(operation) === promise) this.running.delete(operation); }
  }
  async list(agent: unknown, limit = 20): Promise<ImageResult[]> {
    const owner = scopeFor(this.host, agent);
    let names: string[];
    try { names = await readdir(this.directory(owner)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const result: ImageResult[] = [];
    for (const name of names.filter(name => /^[a-f0-9]{40}\.json$/u.test(name))) {
      const record = await this.load(owner, name.slice(0, -5)); if (record) result.push(this.public(record));
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.max(1, Math.min(100, limit)));
  }
  async quiesce(): Promise<void> {
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.running.values()]); await this.queue;
  }
  async dispose(): Promise<void> { this.stopped = true; await this.quiesce(); }
}
export function registerImageTools(service: ImageService): void {
  registerServiceTool(service.host, { name: 'zeta_image_generate', description: '通过ApiMart生成一张真实图片，默认1K、gemini-nano-banana-2.1-ext，关闭费用不确定的官方回退。画自己/自画像必须selfPortrait=true，会自动引用管理员上传的人设原图。可选发送QQ；返回未完成任务时继续查询原id，不要重复生成。',
    parameters: { type: 'object', properties: {
      prompt: { type: 'string' }, size: { type: 'string', enum: RATIOS }, selfPortrait: { type: 'boolean' },
      referenceUrls: { type: 'array', maxItems: 3, items: { type: 'string' } }, send: { type: 'boolean' }, target: { type: 'string' }, wait: { type: 'boolean' },
    }, required: ['prompt'], additionalProperties: false }, execute: (input: ImageInput, exec: ModuleExecution) => service.generate(input, exec) });
  registerServiceTool(service.host, { name: 'zeta_image_status', description: '查询或等待公共库已有的生图任务，不会新建收费任务。历史任务id按原会话迁移映射；查询公共列表中的明确id可用public:<id>。完成后下载图片，只有原任务会话才可执行原任务要求的一次QQ发送。',
    parameters: { type: 'object', properties: { id: { type: 'string' }, wait: { type: 'boolean' } }, required: ['id'], additionalProperties: false },
    execute: (input: { id: string; wait?: boolean }, exec: ModuleExecution) => service.status(input.id, exec, input.wait === true) });
}
