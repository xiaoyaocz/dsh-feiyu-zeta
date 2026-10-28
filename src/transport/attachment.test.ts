import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { LookupAddress } from 'node:dns';
import type { Logger, RawAttachment } from '../types.ts';
import {
  classifyContentType, downloadAttachmentBytes, downloadMediaAttachments,
  isPublicAttachmentAddress, isQqCdnHostname, MAX_ATTACHMENT_BYTES,
  pinnedAttachmentLookup, resolveAttachmentTarget,
  type AttachmentDownloadOptions, type AttachmentResponse, type AttachmentTarget,
} from './attachment.ts';

const safeAddress: LookupAddress = { address: '1.1.1.1', family: 4 };
const publicLookup = vi.fn(async (_hostname: string) => [safeAddress]);
const temporary: string[] = [];
afterEach(async () => {
  publicLookup.mockClear();
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

function response(status = 200, chunks: Uint8Array[] = [Buffer.from('image')], headers: AttachmentResponse['headers'] = {}) {
  const cancel = vi.fn();
  const iterate = vi.fn();
  return {
    status, headers, cancel,
    body: { async *[Symbol.asyncIterator]() { for (const chunk of chunks) { iterate(); yield chunk; } } },
    iterate,
  } satisfies AttachmentResponse & { iterate: ReturnType<typeof vi.fn> };
}

describe('QQ attachment download boundary', () => {
  it('recognizes supported media without changing the voice/ASR path', () => {
    expect(classifyContentType('image/png')).toBe('image');
    expect(classifyContentType('video/mp4')).toBe('video');
    expect(classifyContentType('audio/silk')).toBe('voice');
    expect(classifyContentType('application/pdf')).toBe('file');
  });

  it('allows HTTP on the four exact QQ domain families, including roots, but not suffix lookalikes', async () => {
    for (const host of ['qq.com', 'QQ.COM', 'a.qq.com', 'qq.com.cn', 'a.qq.com.cn', 'qpic.cn', 'gchat.qpic.cn', 'gtimg.cn', 'a.gtimg.cn.']) {
      expect(isQqCdnHostname(host)).toBe(true);
      expect((await resolveAttachmentTarget(`http://${host}/a`, { lookup: publicLookup })).address).toEqual(safeAddress);
    }
    for (const host of ['notqq.com', 'qq.com.evil.test', 'qpic.cn.evil.test', 'evil.test']) {
      expect(isQqCdnHostname(host)).toBe(false);
      await expect(resolveAttachmentTarget(`http://${host}/a`, { lookup: publicLookup })).rejects.toThrow('known QQ CDN');
    }
  });

  it('keeps public HTTPS destinations and normalizes protocol-relative URLs before requesting', async () => {
    const seen: AttachmentTarget[] = [];
    const bytes = await downloadAttachmentBytes('//public.example/a?token=hidden', 1024, {
      lookup: publicLookup,
      request: async (target) => { seen.push(target); return response(); },
    });
    expect(bytes.toString()).toBe('image');
    expect(seen[0]?.url.protocol).toBe('https:');
    expect(seen[0]?.address).toEqual(safeAddress);
    expect(publicLookup).toHaveBeenCalledWith('public.example');
  });

  it('rejects embedded credentials, non-web protocols, private literals and mixed public/private DNS', async () => {
    for (const value of ['https://user:secret@public.example/a', 'file:///etc/passwd', 'ftp://qq.com/a', 'https://127.1/a', 'https://[::1]/a', 'https://[::ffff:127.0.0.1]/a']) {
      await expect(resolveAttachmentTarget(value, { lookup: publicLookup })).rejects.toThrow();
    }
    await expect(resolveAttachmentTarget('https://public.example/a', { lookup: async () => [safeAddress, { address: '10.0.0.1', family: 4 }] })).rejects.toThrow('SSRF');
    await expect(resolveAttachmentTarget('http://qq.com/a', { lookup: async () => [{ address: '192.168.1.2', family: 4 }] })).rejects.toThrow('SSRF');
    await expect(resolveAttachmentTarget('https://public.example/a', { lookup: async () => [] })).rejects.toThrow('SSRF');
  });

  it('rejects reserved IPv4 and IPv6 transition/local ranges and accepts public IPv6', () => {
    for (const address of ['0.0.0.1', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.1.1', '172.16.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.2', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fe80::1', 'ff00::1', '::ffff:10.0.0.1', '2001:db8::1', '2002:7f00:1::', '3fff::1', 'not-an-ip']) {
      expect(isPublicAttachmentAddress(address), address).toBe(false);
    }
    expect(isPublicAttachmentAddress('8.8.8.8')).toBe(true);
    expect(isPublicAttachmentAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('pins the native socket lookup to the checked address rather than resolving the hostname again', () => {
    const lookup = pinnedAttachmentLookup(safeAddress);
    const single = vi.fn(), all = vi.fn();
    lookup('a-now-rebound.example', {}, single);
    lookup('a-now-rebound.example', { all: true }, all);
    expect(single).toHaveBeenCalledWith(null, '1.1.1.1', 4);
    expect(all).toHaveBeenCalledWith(null, [safeAddress]);
  });

  it('validates each manual redirect and accepts a HTTPS-to-known-HTTP CDN transition', async () => {
    const first = response(302, [], { location: 'http://gchat.qpic.cn/final' });
    const last = response(200, [Buffer.from('GIF'), Buffer.from('89a')]);
    const calls: AttachmentTarget[] = [];
    const bytes = await downloadAttachmentBytes('https://download.example/start', 1024, {
      lookup: publicLookup,
      request: async (target) => { calls.push(target); return calls.length === 1 ? first : last; },
    });
    expect(bytes.toString()).toBe('GIF89a');
    expect(calls.map((call) => call.url.protocol)).toEqual(['https:', 'http:']);
    expect(publicLookup.mock.calls.map((call) => call[0])).toEqual(['download.example', 'gchat.qpic.cn']);
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(last.cancel).toHaveBeenCalledOnce();
  });

  it('does not follow redirects to arbitrary HTTP, local HTTPS or a freshly private DNS result', async () => {
    for (const location of ['http://evil.example/a', 'https://127.0.0.1/a', 'https://[fc00::1]/a']) {
      const request = vi.fn(async () => response(302, [], { location }));
      await expect(downloadAttachmentBytes('https://safe.example/a', 1024, { lookup: publicLookup, request })).rejects.toThrow();
      expect(request).toHaveBeenCalledOnce();
    }
    let lookups = 0;
    const request = vi.fn(async () => response(302, [], { location: '/rebound' }));
    await expect(downloadAttachmentBytes('https://safe.example/a', 1024, {
      lookup: async () => ++lookups === 1 ? [safeAddress] : [{ address: '10.0.0.1', family: 4 }], request,
    })).rejects.toThrow('SSRF');
    expect(lookups).toBe(2);
    expect(request).toHaveBeenCalledOnce();
  });

  it('limits redirect loops and refuses a missing redirect Location', async () => {
    const request = vi.fn(async () => response(302, [], { location: '/again' }));
    await expect(downloadAttachmentBytes('https://safe.example/a', 1024, { lookup: publicLookup, request, redirects: 2 })).rejects.toThrow('redirect limit');
    expect(request).toHaveBeenCalledTimes(3);
    await expect(downloadAttachmentBytes('https://safe.example/a', 1024, { lookup: publicLookup, request: async () => response(301) })).rejects.toThrow('missing Location');
  });

  it('enforces the Content-Length and actual streamed-byte limits and rejects compressed content', async () => {
    const declared = response(200, [Buffer.alloc(1)], { 'content-length': String(MAX_ATTACHMENT_BYTES + 1) });
    await expect(downloadAttachmentBytes('https://safe.example/a', MAX_ATTACHMENT_BYTES * 8, { lookup: publicLookup, request: async () => declared })).rejects.toThrow('size limit');
    expect(declared.iterate).not.toHaveBeenCalled();
    expect(declared.cancel).toHaveBeenCalledOnce();
    const chunked = response(200, [Buffer.alloc(600), Buffer.alloc(600)]);
    await expect(downloadAttachmentBytes('https://safe.example/a', 1024, { lookup: publicLookup, request: async () => chunked })).rejects.toThrow('size limit');
    expect(chunked.cancel).toHaveBeenCalledOnce();
    await expect(downloadAttachmentBytes('https://safe.example/a', 1024, { lookup: publicLookup, request: async () => response(200, [], { 'content-encoding': 'gzip' }) })).rejects.toThrow('encoding');
  });

  it('caps actual chunked transfers at 30MiB even when configuration requests 200MiB', async () => {
    const chunk = Buffer.alloc(1024 * 1024);
    const result = response(200, Array.from({ length: 31 }, () => chunk));
    await expect(downloadAttachmentBytes('https://safe.example/a', 200 * 1024 * 1024, { lookup: publicLookup, request: async () => result })).rejects.toThrow('30MB size limit');
    expect(result.iterate).toHaveBeenCalledTimes(31);
    expect(result.cancel).toHaveBeenCalledOnce();
  });

  it('bounds DNS and streaming waits and honors an explicit cancellation signal', async () => {
    const stalledLookup = () => new Promise<LookupAddress[]>(() => {});
    await expect(downloadAttachmentBytes('https://safe.example/a', 1024, { timeoutMs: 10, lookup: stalledLookup })).rejects.toThrow();
    const cancel = vi.fn();
    const stalled: AttachmentResponse = { status: 200, headers: {}, cancel, body: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => {}) }) } };
    await expect(downloadAttachmentBytes('https://safe.example/a', 1024, { timeoutMs: 10, lookup: publicLookup, request: async () => stalled })).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
    const controller = new AbortController();
    controller.abort(new Error('user stopped'));
    const request = vi.fn(async () => response());
    await expect(downloadAttachmentBytes('https://safe.example/a', 1024, { signal: controller.signal, lookup: publicLookup, request })).rejects.toThrow('user stopped');
    expect(request).not.toHaveBeenCalled();
  });

  it('cancels an already-open response when the caller stops the download', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const request = async (): Promise<AttachmentResponse> => ({
      status: 200, headers: {}, cancel,
      body: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => { controller.abort(new Error('stop while reading')); }) }) },
    });
    await expect(downloadAttachmentBytes('https://safe.example/a', 1024, { lookup: publicLookup, request, signal: controller.signal })).rejects.toThrow('stop while reading');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('writes only successful bounded attachments, keeps original message metadata, and skips voice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zeta-attachments-'));
    temporary.push(root);
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const request = vi.fn(async (target: AttachmentTarget) => target.url.pathname === '/bad' ? response(404) : response(200, [Buffer.from('original-image')]));
    const attachments: RawAttachment[] = [
      { filename: '../原图.png', content_type: 'image/png', size: 10, url: 'http://gchat.qpic.cn/good' },
      { filename: 'bad.png', content_type: 'image/png', size: 10, url: 'https://safe.example/bad' },
      { filename: 'huge.png', content_type: 'image/png', size: MAX_ATTACHMENT_BYTES + 1, url: 'https://safe.example/huge' },
      { filename: 'voice.silk', content_type: 'audio/silk', size: 10, url: 'https://safe.example/voice' },
    ];
    const options: AttachmentDownloadOptions = { lookup: publicLookup, request, mediaRoot: root };
    const result = await downloadMediaAttachments(attachments, { enabled: true, maxMB: 200, ttlHours: 24 }, logger, options);
    expect(result).toHaveLength(1);
    expect(result[0]?.filename).toBe('../原图.png');
    expect(result[0]?.contentType).toBe('image');
    expect(basename(result[0]!.localPath)).toMatch(/^原图_\d+_[a-f0-9]{8}\.png$/u);
    expect(await readFile(result[0]!.localPath, 'utf8')).toBe('original-image');
    expect(await readdir(root)).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(await downloadMediaAttachments(attachments, { enabled: false, maxMB: 200, ttlHours: 24 }, logger, options)).toEqual([]);
  });
});
