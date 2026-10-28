/**
 * 富媒体下载 — 将 QQ 图片/视频/file 附件安全下载到本地
 *
 * 下载后仅通过本地绝对路径提示模型，由模型通过 qqbot_describe_image / ffmpeg / tool-fs 等工具自行分析，
 *
 * 下载目录固定为 ~/.dsh-qqbot/media，
 * 文件名用时间戳+随机数防重名，不依赖 agent cwd，便于 qqbot_describe_image / tool-fs 等工具稳定访问。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as dns from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Logger, RawAttachment } from '../types.ts';
import type { MediaConfig } from '../config.ts';
import { MEDIA_ROOT } from '../media/media-cleaner.ts';

/** A provider's reported size is not trusted; actual reads are always capped. */
export const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;
/** 下载超时（毫秒） */
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 3;

export interface AttachmentTarget {
  url: URL;
  address: dns.LookupAddress;
}

export interface AttachmentResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: AsyncIterable<Uint8Array>;
  cancel(): void;
}

export interface AttachmentDownloadOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  redirects?: number;
  /** Test seam. Production always resolves and pins the actual connection. */
  lookup?: (hostname: string) => Promise<dns.LookupAddress[]>;
  request?: (target: AttachmentTarget, signal: AbortSignal) => Promise<AttachmentResponse>;
  /** Test destination; normal QQ transport continues to use MEDIA_ROOT. */
  mediaRoot?: string;
}

/** 下载结果 */
export interface DownloadedFile {
  /** 原始文件名（用于与消息附件关联） */
  filename: string;
  /** 附件类型 */
  contentType: 'image' | 'video' | 'file';
  /** 本地绝对路径 */
  localPath: string;
}

/** 附件归类（QQ 网关的 content_type 是 MIME 类型，如 image/png、video/mp4、audio/silk） */
export type MediaKind = 'image' | 'video' | 'voice' | 'file';

/** 是否为图片（兼容裸值 'image' 与 MIME 'image/png'） */
export function isImageContentType(contentType?: string): boolean {
  return contentType === 'image' || contentType?.startsWith('image/') === true;
}

/** 是否为视频（兼容裸值 'video' 与 MIME 'video/mp4'） */
export function isVideoContentType(contentType?: string): boolean {
  return contentType === 'video' || contentType?.startsWith('video/') === true;
}

/** 是否为语音（兼容裸值 'voice' 与 MIME 'audio/silk'） */
export function isVoiceContentType(contentType?: string): boolean {
  return contentType === 'voice' || contentType?.startsWith('audio/') === true;
}

/** 归类附件 content_type 为统一类型 */
export function classifyContentType(contentType?: string): MediaKind {
  if (isImageContentType(contentType)) return 'image';
  if (isVideoContentType(contentType)) return 'video';
  if (isVoiceContentType(contentType)) return 'voice';
  return 'file';
}

/** 处理 `//` 开头的协议相对 URL（补 https:） */
function normalizeUrl(url: string): string {
  return url.startsWith('//') ? `https:${url}` : url;
}

/** 文件名净化：去路径、移除非法字符（保留中文等 Unicode 字符），防止路径穿越 */
function sanitizeFilename(name: string): string {
  const base = basename(name.replace(/\\/g, '/'));
  // 仅替换文件系统非法字符（Windows 保留字符 + 控制字符），保留中文/空格等
  // normalize NFC：统一 Unicode 规范化，避免 macOS(NFD) 与 Linux/Windows(NFC) 存储差异导致路径对不上
  const safe = base
    .replace(/[<>:"|?*\x00-\x1f]/g, '_')
    .trim()
    .normalize('NFC');
  return safe || 'attachment';
}

/** 统一路径分隔符为 `/`（POSIX），Node fs 在 Windows 也接受正斜杠，保证注入路径跨平台一致 */
function toPosixPath(p: string): string {
  return p.split(sep).join('/');
}

/** 防重名：文件名 + 时间戳 + 随机数 */
function uniqueFilename(name: string): string {
  const base = sanitizeFilename(name);
  const ext = extname(base);
  const stem = basename(base, ext);
  const rand = randomBytes(4).toString('hex');
  return `${stem}_${Date.now()}_${rand}${ext}`;
}

/** 字节数格式化 */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

// ── Download policy: public sockets only, HTTP only for known QQ CDN domains. ──
const QQ_CDN_SUFFIXES = ['qq.com', 'qq.com.cn', 'qpic.cn', 'gtimg.cn'];
const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockedV4.addSubnet(address, prefix);
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new BlockList();
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  blockedV6.addSubnet(address, prefix, 'ipv6');
}

export function isQqCdnHostname(value: string): boolean {
  const hostname = value.toLowerCase().replace(/\.$/, '');
  return QQ_CDN_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

/** Conservative public unicast policy, including mapped/private IPv6 rejection. */
export function isPublicAttachmentAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, 'ipv4');
  if (family === 6) return globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
  return false;
}

function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Attachment download cancelled'));
    if (signal.aborted) {
      pending.catch(() => undefined);
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Each redirect performs a fresh lookup. The socket must use only this checked result. */
export async function resolveAttachmentTarget(value: string, options: AttachmentDownloadOptions = {}): Promise<AttachmentTarget> {
  const parsed = new URL(normalizeUrl(value));
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) throw new Error('Attachment URL must be HTTP(S) without embedded credentials');
  if (parsed.protocol === 'http:' && !isQqCdnHostname(parsed.hostname)) throw new Error('HTTP attachments are allowed only on known QQ CDN domains');
  const host = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const signal = options.signal ?? AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  signal.throwIfAborted();
  const literalFamily = isIP(host);
  const addresses = literalFamily
    ? [{ address: host, family: literalFamily }]
    : await withAbort((options.lookup ?? ((name) => dns.promises.lookup(name, { all: true, verbatim: true })))(host), signal);
  if (!addresses.length || addresses.some((entry) => isIP(entry.address) !== entry.family || !isPublicAttachmentAddress(entry.address))) throw new Error('SSRF blocked: attachment destination is not a public address');
  const address = addresses.find((entry) => entry.family === 4) ?? addresses[0]!;
  return { url: parsed, address };
}

/** Native request avoids fetch's second DNS resolution and automatic redirects. */
export function pinnedAttachmentLookup(address: dns.LookupAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [address]);
    else callback(null, address.address, address.family);
  };
}

export function requestPinnedAttachment(target: AttachmentTarget, signal: AbortSignal): Promise<AttachmentResponse> {
  return new Promise((resolve, reject) => {
    const request = (target.url.protocol === 'https:' ? httpsRequest : httpRequest)(target.url, {
      method: 'GET', agent: false, signal, lookup: pinnedAttachmentLookup(target.address),
      headers: { 'accept-encoding': 'identity', 'user-agent': 'dsh-feiyu-zeta/0.4.1' },
    }, (response) => resolve({
      status: response.statusCode ?? 500,
      headers: response.headers,
      body: response,
      cancel: () => response.destroy(),
    }));
    request.once('error', reject);
    request.end();
  });
}

/** Bounded streaming read; never materialize an unbounded Response.arrayBuffer(). */
export async function downloadAttachmentBytes(value: string, requestedMaxBytes = MAX_ATTACHMENT_BYTES, options: AttachmentDownloadOptions = {}): Promise<Buffer> {
  if (!Number.isFinite(requestedMaxBytes) || requestedMaxBytes < 1) throw new Error('Attachment size limit is invalid');
  const maxBytes = Math.min(MAX_ATTACHMENT_BYTES, Math.floor(requestedMaxBytes));
  const timeout = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const redirects = options.redirects ?? MAX_REDIRECTS;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300000 || !Number.isInteger(redirects) || redirects < 0 || redirects > 5) throw new Error('Attachment download options are invalid');
  const signal = AbortSignal.any([AbortSignal.timeout(timeout), ...(options.signal ? [options.signal] : [])]);
  let current = value;
  for (let hop = 0; ; hop++) {
    const target = await resolveAttachmentTarget(current, { ...options, signal });
    const response = await withAbort((options.request ?? requestPinnedAttachment)(target, signal).then((response) => {
      if (signal.aborted) { response.cancel(); signal.throwIfAborted(); }
      return response;
    }), signal);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      response.cancel();
      const location = response.headers.location;
      if (!location || hop >= redirects) throw new Error('Attachment redirect limit exceeded or missing Location');
      current = new URL(location, target.url).href;
      continue;
    }
    try {
      if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
      const encoding = response.headers['content-encoding'];
      if (encoding && encoding.toLowerCase() !== 'identity') throw new Error('Attachment content encoding is not supported');
      const lengthHeader = response.headers['content-length'];
      if (lengthHeader !== undefined) {
        const length = Number(lengthHeader);
        if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) throw new Error('Attachment Content-Length exceeds size limit or is invalid');
      }
      const chunks: Buffer[] = [];
      const iterator = response.body[Symbol.asyncIterator]();
      let length = 0;
      for (;;) {
        const step = await withAbort(iterator.next(), signal);
        if (step.done) break;
        if (!(step.value instanceof Uint8Array)) throw new Error('Invalid attachment response chunk');
        length += step.value.byteLength;
        if (length > maxBytes) throw new Error(`Download exceeds ${Math.floor(maxBytes / 1024 / 1024)}MB size limit`);
        chunks.push(Buffer.from(step.value));
      }
      signal.throwIfAborted();
      return Buffer.concat(chunks, length);
    } finally { response.cancel(); }
  }
}

async function download(url: string, destPath: string, maxBytes: number, options: AttachmentDownloadOptions): Promise<number> {
  const bytes = await downloadAttachmentBytes(url, maxBytes, options);
  options.signal?.throwIfAborted();
  writeFileSync(destPath, bytes, { flag: 'wx' });
  return bytes.length;
}

/**
 * 下载消息中的富媒体附件（image/video/file）到本地
 *
 * 下载目录固定为 ~/.dsh-qqbot/media，文件名用时间戳+随机数防重名。
 * 下载失败不阻断（由调用方回退描述）。
 */
export async function downloadMediaAttachments(
  attachments: RawAttachment[] | undefined,
  media: MediaConfig,
  logger: Logger,
  options: AttachmentDownloadOptions = {},
): Promise<DownloadedFile[]> {
  if (!media.enabled) return [];

  const targets = (attachments ?? []).filter(a =>
    classifyContentType(a.content_type) !== 'voice' && a.url,
  );
  if (targets.length === 0) return [];

  const mediaRoot = options.mediaRoot ?? MEDIA_ROOT;
  mkdirSync(mediaRoot, { recursive: true });

  const requestedMaxMB = media.maxMB;
  const maxBytes = Math.min(MAX_ATTACHMENT_BYTES, Number.isFinite(requestedMaxMB) && requestedMaxMB > 0 ? requestedMaxMB * 1024 * 1024 : MAX_ATTACHMENT_BYTES);

  const results: DownloadedFile[] = [];
  for (const att of targets) {
    const contentType = classifyContentType(att.content_type) as 'image' | 'video' | 'file';
    options.signal?.throwIfAborted();
    const localPath = toPosixPath(join(mediaRoot, uniqueFilename(att.filename)));

    if (att.size > maxBytes) {
      logger.debug(`im-qqbot: skip download (${att.size}B too large): ${att.filename}`);
      continue; // 超限不下载，由 buildDynamicCtx 回退为描述
    }

    let bytes: number;
    try {
      bytes = await download(att.url, localPath, maxBytes, options);
    } catch (err) {
      if (options.signal?.aborted) throw options.signal.reason;
      logger.warn(`im-qqbot: download failed: ${att.filename} — ${err instanceof Error ? err.message : String(err)}`);
      continue; // 下载失败不加入结果，由 buildDynamicCtx 回退为描述
    }
    logger.debug(`im-qqbot: attachment downloaded: ${att.filename} (${formatSize(bytes)}) → ${localPath}`);

    results.push({ filename: att.filename, contentType, localPath });
  }

  return results;
}
