import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModuleHost } from './contracts.ts';
import { atomicJson, readServiceJson, registerServiceTool, ServiceError, serviceHash } from './browser.ts';

export interface PersonaReference {
  id: string;
  fileName: string;
  filePath: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  bytes: number;
  description: string;
  createdAt: string;
}
interface PersonaRecord extends Omit<PersonaReference, 'filePath'> { sha256: string }
export interface PersonaUpload { bytes: Buffer; fileName?: string; description?: string }
export function imageMime(bytes: Buffer): PersonaReference['mimeType'] {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('ascii', 12, 16) === 'IHDR') return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) return 'image/jpeg';
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new ServiceError('INVALID_IMAGE', '仅支持有效的 PNG、JPEG 或 WebP 图片。');
}
export class PersonaService {
  private queue: Promise<unknown> = Promise.resolve();
  private current?: PersonaReference;
  constructor(readonly host: ModuleHost) {}
  private get directory(): string { return join(this.host.dataDir, 'persona'); }
  private get manifest(): string { return join(this.directory, 'reference.json'); }
  private async record(): Promise<PersonaRecord | undefined> {
    const value = await readServiceJson<PersonaRecord>(this.manifest);
    if (!value) return undefined;
    if (!/^[a-f0-9-]{36}$/u.test(value.id) || !/^[a-f0-9]{64}$/u.test(value.sha256) ||
      value.fileName !== `${value.id}.${value.mimeType === 'image/png' ? 'png' : value.mimeType === 'image/jpeg' ? 'jpg' : value.mimeType === 'image/webp' ? 'webp' : 'invalid'}`) {
      throw new ServiceError('LOCAL_STATE', '人设图记录无效。');
    }
    return value;
  }
  private reference(record: PersonaRecord): PersonaReference {
    const { sha256: _hash, ...value } = record;
    return { ...value, filePath: join(this.directory, value.fileName) };
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const task = this.queue.then(run); this.queue = task.catch(() => {}); return task;
  }
  async get(): Promise<PersonaReference | undefined> { const record = await this.record(); this.current = record ? this.reference(record) : undefined; return this.current; }
  contextText(): string {
    const current = this.current;
    return current ? `这是你自己的统一形象参考图：${current.filePath}。${current.description ? `管理员提供的外观描述：${current.description}` : '尚未填写外观描述；需要了解视觉细节时请调用看图工具，不要编造已经看过。'}画自己或自画像时调用zeta_image_generate，设置selfPortrait=true，服务会自动附上原图。` : '';
  }
  async upload(input: PersonaUpload): Promise<PersonaReference> {
    this.host.requireWritable?.();
    if (!Buffer.isBuffer(input.bytes) || input.bytes.length < 4 || input.bytes.length > 8 * 1024 * 1024) throw new ServiceError('INVALID_IMAGE', '人设图应为不超过 8 MiB 的 PNG、JPEG 或 WebP。');
    const description = (input.description ?? '').trim();
    if (description.length > 4000 || description.includes('\u0000')) throw new ServiceError('INVALID_ARGUMENT', '外观描述不能超过 4000 字符。');
    const mimeType = imageMime(input.bytes);
    return this.serial(async () => {
      const previous = await this.record();
      const id = randomUUID();
      const fileName = `${id}.${mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : 'webp'}`;
      await mkdir(this.directory, { recursive: true });
      await writeFile(join(this.directory, fileName), input.bytes, { flag: 'wx', mode: 0o600 });
      const record: PersonaRecord = { id, fileName, mimeType, bytes: input.bytes.length, description, createdAt: new Date().toISOString(), sha256: serviceHash(input.bytes) };
      await atomicJson(this.manifest, record);
      if (previous) await unlink(join(this.directory, previous.fileName)).catch(() => {});
      this.current = this.reference(record); return this.current;
    });
  }
  async setDescription(description: string): Promise<PersonaReference> {
    this.host.requireWritable?.();
    if (typeof description !== 'string' || description.length > 4000 || description.includes('\u0000')) throw new ServiceError('INVALID_ARGUMENT', '外观描述不能超过 4000 字符。');
    return this.serial(async () => {
      const record = await this.record();
      if (!record) throw new ServiceError('NO_PERSONA', '尚未上传人设图。');
      record.description = description.trim(); await atomicJson(this.manifest, record); this.current = this.reference(record); return this.current;
    });
  }
  async remove(): Promise<void> {
    this.host.requireWritable?.();
    await this.serial(async () => {
      const record = await this.record();
      await unlink(this.manifest).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      if (record) await unlink(join(this.directory, record.fileName)).catch(() => {});
      this.current = undefined;
    });
  }
  async referenceDataUrl(): Promise<string | undefined> {
    const record = await this.record();
    if (!record) return undefined;
    const bytes = await readFile(join(this.directory, record.fileName));
    if (serviceHash(bytes) !== record.sha256 || imageMime(bytes) !== record.mimeType) throw new ServiceError('LOCAL_STATE', '人设图校验失败；不会使用损坏的参考图。');
    return `data:${record.mimeType};base64,${bytes.toString('base64')}`;
  }
  async quiesce(): Promise<void> { await this.queue; }
  async dispose(): Promise<void> { await this.quiesce(); }
}
export function registerPersonaTools(service: PersonaService): void {
  registerServiceTool(service.host, { name: 'zeta_persona_reference',
    description: '查看自己的统一人设图路径与管理员提供的外观描述。需要视觉确认时用现有看图工具读取filePath；不能把尚未读图当作已经看过。画自画像时使用zeta_image_generate并令selfPortrait=true，服务会自动附人设原图。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ reference: await service.get() ?? null }) });
}
