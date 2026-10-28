import type { Context } from '@deepseek-ai/cordis';
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { type SessionHeader } from '@deepseek-ai/dsh-session';
export declare const MAX_SESSION_TRANSFER_BYTES: number;
export interface SessionTransferEntry {
    id: string;
    path: string;
    header: SessionHeader;
    inheritedEventCount: number;
    eventCount: number;
}
export type AttachmentTransferEntry = {
    kind: 'image';
    ref: ImageAttachmentRef;
    path: string;
} | {
    kind: 'file';
    ref: FileAttachmentRef;
    path: string;
};
export interface SessionTransferExport {
    sessions: SessionTransferEntry[];
    attachments: AttachmentTransferEntry[];
    warnings: string[];
}
export interface ValidatedSessionEntry extends SessionTransferEntry {
    sourceHeader: SessionHeader;
    sourceFile: string;
    sha256: string;
}
export type ValidatedAttachmentEntry = AttachmentTransferEntry & {
    sourceFile: string;
    sha256: string;
};
export interface ValidatedSessionTransfer {
    sessions: readonly ValidatedSessionEntry[];
    attachments: readonly ValidatedAttachmentEntry[];
    warnings: readonly string[];
    conflicts: readonly string[];
    cwdRoot: string;
}
/** Same source directory maps to the same new workspace, across sessions and QQ config. */
export declare function mappedWorkspace(cwdRoot: string, oldCwd?: string): string;
/** Exports a raw persistence prefix, without SessionQuery repair or Agent activation. */
export declare function exportSessions(ctx: Context, rootIds: string[], stageDir: string, signal: AbortSignal): Promise<SessionTransferExport>;
/** Full validation is read-only; workspace directories and native objects are not created. */
export declare function validateSessionTransfer(ctx: Context, root: string, sessions: readonly SessionTransferEntry[], attachments: readonly AttachmentTransferEntry[], cwdRoot: string, signal: AbortSignal, options?: {
    resume?: boolean;
}): Promise<ValidatedSessionTransfer>;
/** Writes only native attachments and persistence handles; it never resolves or starts an Agent. */
export declare function restoreSessions(ctx: Context, plan: ValidatedSessionTransfer, signal: AbortSignal, options?: {
    resume: boolean;
}): Promise<{
    sessions: number;
    attachments: number;
    warnings: string[];
}>;
//# sourceMappingURL=backup-sessions.d.ts.map