import type { ModuleHost } from './contracts.ts';
export { migrateLegacyMemeCollections } from './memes-migration.ts';
export interface MemeItem {
    id: string;
    caption: string;
    tag: string;
    keywords: string[];
    fileName: string;
    builtin: boolean;
}
export interface MemeMetadata {
    caption: string;
    tag?: string;
    keywords?: string[];
}
export interface MemeListOptions {
    query?: string;
    tag?: string;
    limit?: number;
    offset?: number;
}
export interface MemeModuleOptions {
    builtinRoot?: string;
    maxImageBytes?: number;
    maxCollectionItems?: number;
    /** Trusted input paths recorded by the QQ adapter, never model-selected roots. */
    allowedInputFiles?: (agent: unknown) => readonly string[] | Promise<readonly string[]>;
}
export interface MemeZipImportResult {
    imported: number;
    items: MemeItem[];
    skipped: number;
    complete: boolean;
    cancelled?: boolean;
    error?: string;
}
/** Builtin packs are read-only; every trusted conversation uses one collection. */
export declare class MemeModule {
    private readonly host;
    private readonly options;
    private readonly builtinRoot;
    private readonly queues;
    private readonly maxImageBytes;
    private readonly maxCollectionItems;
    private readonly migrations;
    constructor(host: ModuleHost, options?: MemeModuleOptions);
    private assertAgent;
    private collectionRoot;
    private serialized;
    private locatedItems;
    list(agent: unknown, options?: MemeListOptions): Promise<{
        items: MemeItem[];
        total: number;
        hasMore: boolean;
    }>;
    private locate;
    fileFor(agent: unknown, id: string): Promise<string>;
    send(agent: unknown, id: string, target: string | undefined, signal: AbortSignal): Promise<{
        item: MemeItem;
        sent: true;
        receipt: Record<string, unknown>;
    }>;
    importImage(agent: unknown, bytes: Uint8Array, fileName: string, meta: MemeMetadata, signal?: AbortSignal): Promise<MemeItem>;
    learn(agent: unknown, input: {
        filePath: string;
    } & MemeMetadata, signal: AbortSignal): Promise<MemeItem>;
    update(agent: unknown, id: string, patch: Partial<MemeMetadata>): Promise<MemeItem>;
    /** Export the upstream-compatible index.db + manifest.json + indexed image format. */
    exportZip(agent: unknown, options?: {
        library?: 'collection' | 'builtin';
    }): Promise<Buffer>;
    /** Import an upstream pack or image-only ZIP into the current collection. */
    importZip(agent: unknown, bytes: Uint8Array, signal?: AbortSignal): Promise<MemeZipImportResult>;
    /** Administrator management operation; intentionally not an agent tool. */
    delete(agent: unknown, id: string): Promise<{
        deleted: true;
    }>;
    dispose(): Promise<void>;
}
/** Register the four native dsh-meme tool names once, without upstream's global routes. */
export declare function registerMemeTools(host: ModuleHost, options?: MemeModuleOptions): MemeModule;
//# sourceMappingURL=memes.d.ts.map