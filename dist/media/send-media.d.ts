import type { ReplyTarget } from '../types.ts';
import type { SendFileConfig } from '../config.ts';
/** 发送器最小接口（QQBot 实例满足） */
export interface MediaSendResult {
    upload: {
        file_uuid: string;
    };
    message?: {
        id?: string;
    };
}
export interface MediaSenderLike {
    sendImage(target: ReplyTarget, source: {
        localPath?: string;
    }): Promise<MediaSendResult>;
    sendVideo(target: ReplyTarget, source: {
        localPath?: string;
    }): Promise<MediaSendResult>;
    sendVoice(target: ReplyTarget, source: {
        localPath?: string;
    }): Promise<MediaSendResult>;
    sendFile(target: ReplyTarget, source: {
        localPath?: string;
    }, opts?: {
        fileName?: string;
    }): Promise<MediaSendResult>;
}
/** 判断 filePath 是否位于 root 目录内（含 root 本身） */
export declare function isWithinRoot(filePath: string, root: string): boolean;
/** 路径白名单校验：restrictPaths 关闭时放行任意路径，否则限定 media + cwd + extraRoots */
export declare function isPathAllowed(filePath: string, config: SendFileConfig, cwd: string): boolean;
/** sendMediaFile 的结果：成功附带元数据；缺失不抛错；失败携带原因供日志与错误信息透出 */
export type SendMediaResult = {
    outcome: 'sent';
    size: number;
    fileUuid?: string;
    messageId?: string;
} | {
    outcome: 'missing';
} | {
    outcome: 'failed';
    error: string;
};
/**
 * 按扩展名分类发送一个本地文件
 *
 * 文件不存在、不是普通文件时返回 missing（不抛错，调用方决定降级文案）；
 * 平台发送失败返回 failed。文件名透传给通用文件通道。
 */
export declare function sendMediaFile(bot: MediaSenderLike, target: ReplyTarget, filePath: string, opts?: {
    fileName?: string;
    signal?: AbortSignal;
}): Promise<SendMediaResult>;
//# sourceMappingURL=send-media.d.ts.map