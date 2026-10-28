import * as dns from 'node:dns';
import { type LookupFunction } from 'node:net';
import { type IncomingHttpHeaders } from 'node:http';
import type { Logger, RawAttachment } from '../types.ts';
import type { MediaConfig } from '../config.ts';
/** A provider's reported size is not trusted; actual reads are always capped. */
export declare const MAX_ATTACHMENT_BYTES: number;
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
export declare function isImageContentType(contentType?: string): boolean;
/** 是否为视频（兼容裸值 'video' 与 MIME 'video/mp4'） */
export declare function isVideoContentType(contentType?: string): boolean;
/** 是否为语音（兼容裸值 'voice' 与 MIME 'audio/silk'） */
export declare function isVoiceContentType(contentType?: string): boolean;
/** 归类附件 content_type 为统一类型 */
export declare function classifyContentType(contentType?: string): MediaKind;
export declare function isQqCdnHostname(value: string): boolean;
/** Conservative public unicast policy, including mapped/private IPv6 rejection. */
export declare function isPublicAttachmentAddress(address: string): boolean;
/** Each redirect performs a fresh lookup. The socket must use only this checked result. */
export declare function resolveAttachmentTarget(value: string, options?: AttachmentDownloadOptions): Promise<AttachmentTarget>;
/** Native request avoids fetch's second DNS resolution and automatic redirects. */
export declare function pinnedAttachmentLookup(address: dns.LookupAddress): LookupFunction;
export declare function requestPinnedAttachment(target: AttachmentTarget, signal: AbortSignal): Promise<AttachmentResponse>;
/** Bounded streaming read; never materialize an unbounded Response.arrayBuffer(). */
export declare function downloadAttachmentBytes(value: string, requestedMaxBytes?: number, options?: AttachmentDownloadOptions): Promise<Buffer>;
/**
 * 下载消息中的富媒体附件（image/video/file）到本地
 *
 * 下载目录固定为 ~/.dsh-qqbot/media，文件名用时间戳+随机数防重名。
 * 下载失败不阻断（由调用方回退描述）。
 */
export declare function downloadMediaAttachments(attachments: RawAttachment[] | undefined, media: MediaConfig, logger: Logger, options?: AttachmentDownloadOptions): Promise<DownloadedFile[]>;
//# sourceMappingURL=attachment.d.ts.map