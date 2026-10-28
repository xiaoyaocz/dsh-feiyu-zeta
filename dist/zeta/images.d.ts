import type { ModuleExecution } from './contracts.ts';
import { type ExternalModuleHost } from './browser.ts';
import { type PersonaService } from './persona.ts';
export interface ImageSettings {
    enabled: boolean;
    model: string;
    resolution: '1K' | '2K' | '4K';
    timeoutMs: number;
    pollIntervalMs: number;
    maxWaitMs: number;
    maxPromptCharacters: number;
    maxImageBytes: number;
    dailyLimit: number;
}
export declare const DEFAULT_IMAGE_SETTINGS: ImageSettings;
export interface ImageInput {
    prompt: string;
    size?: string;
    selfPortrait?: boolean;
    referenceUrls?: string[];
    send?: boolean;
    target?: string;
    wait?: boolean;
}
export interface ImageResult {
    id: string;
    taskId?: string;
    status: 'submitting' | 'unknown' | 'pending' | 'processing' | 'completed' | 'failed';
    model: string;
    resolution: string;
    createdAt: string;
    selfPortrait: boolean;
    filePath?: string;
    mimeType?: string;
    bytes?: number;
    delivery: 'not_requested' | 'pending' | 'sent' | 'failed' | 'unknown';
    cost?: number;
    notice?: string;
}
export interface ImageOptions {
    fetch?: typeof fetch;
    beforeGenerate?: (input: ImageInput, exec: ModuleExecution) => void | Promise<void>;
}
export declare class ImageService {
    readonly host: ExternalModuleHost;
    readonly getSettings: () => ImageSettings | Promise<ImageSettings>;
    readonly persona: PersonaService;
    readonly options: ImageOptions;
    private readonly requestFetch;
    private readonly running;
    private readonly controllers;
    private queue;
    private stopped;
    constructor(host: ExternalModuleHost, getSettings: () => ImageSettings | Promise<ImageSettings>, persona: PersonaService, options?: ImageOptions);
    private get root();
    private directory;
    private path;
    private serial;
    private public;
    private settings;
    private validate;
    private key;
    private reserve;
    private load;
    generate(raw: ImageInput, exec: ModuleExecution): Promise<ImageResult>;
    private generateOnce;
    private refresh;
    private download;
    status(id: string, exec: ModuleExecution, wait?: boolean): Promise<ImageResult>;
    list(agent: unknown, limit?: number): Promise<ImageResult[]>;
    quiesce(): Promise<void>;
    dispose(): Promise<void>;
}
export declare function registerImageTools(service: ImageService): void;
//# sourceMappingURL=images.d.ts.map