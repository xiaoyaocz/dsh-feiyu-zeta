import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type { MemeModule } from './memes.ts';
import type { ZetaRuntime } from './runtime.ts';
export interface BackupPreview {
    formatVersion: number;
    pluginVersion: string;
    dshVersion: string;
    createdAt: string;
    sessions: number;
    memoryItems: number;
    conversations: number;
    files: number;
    bytes: number;
    includesCredentials: boolean;
    warnings: string[];
    canRestore: boolean;
    conflicts: string[];
}
/** Owner-only portability service. It never registers a model tool. */
export declare class BackupService {
    private readonly ctx;
    private readonly runtime;
    private readonly memes;
    private readonly stages;
    private readonly operations;
    private committing;
    private disposed;
    private activeRestore?;
    private busy;
    private readonly home;
    private readonly tempRoot;
    constructor(ctx: Context, runtime: ZetaRuntime, memes: MemeModule);
    status(): {
        restartRequired: boolean;
        canActivate: boolean;
        maintenance: boolean;
        pendingRestore: boolean;
    };
    private temporary;
    private cleanup;
    private snapshotFiles;
    private pluginEntries;
    private exportBundle;
    private freshConflicts;
    private preview;
    private restore;
    handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void>;
    private download;
    dispose(): Promise<void>;
}
//# sourceMappingURL=backup.d.ts.map