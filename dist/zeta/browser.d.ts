import { type Browser } from 'playwright-core';
import type { ModuleExecution, ModuleHost } from './contracts.ts';
export interface ExternalModuleHost extends ModuleHost {
    resolveServiceKey(provider: 'cloudflare' | 'apimart'): Promise<string>;
}
export interface BrowserSettings {
    enabled: boolean;
    accountId: string;
    maxConcurrent: number;
    maxSessionMs: number;
    idleTimeoutMs: number;
    dailyBudgetMs: number;
    actionTimeoutMs: number;
}
export declare const DEFAULT_BROWSER_SETTINGS: BrowserSettings;
export declare class ServiceError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function scopeFor(host: ModuleHost, agent: unknown): string;
export declare const serviceHash: (value: string | Buffer) => string;
export declare function serviceObject(value: unknown): Record<string, unknown>;
export declare function serviceAbort(signal: AbortSignal): void;
export declare function atomicJson(path: string, data: unknown): Promise<void>;
export declare function readServiceJson<T>(path: string): Promise<T | undefined>;
export declare function boundedBytes(response: Response, maximum: number, signal: AbortSignal): Promise<Buffer>;
export declare function responseObject(response: Response, signal: AbortSignal): Promise<Record<string, unknown>>;
export declare function publicHttpUrl(value: unknown): string;
export declare function registerServiceTool(host: ModuleHost, definition: Record<string, unknown>): void;
export type BrowserAction = {
    action: 'goto';
    url: string;
} | {
    action: 'read';
    selector?: string;
} | {
    action: 'click';
    selector: string;
} | {
    action: 'fill';
    selector: string;
    value: string;
} | {
    action: 'screenshot';
};
export interface BrowserInput {
    actions: BrowserAction[];
    session?: string;
    keepSession?: boolean;
}
export interface BrowserOptions {
    fetch?: typeof fetch;
    connect?: (url: string, headers: Record<string, string>) => Promise<Browser>;
    beforeBrowse?: (input: BrowserInput, exec: ModuleExecution) => void | Promise<void>;
}
export declare class BrowserService {
    readonly host: ExternalModuleHost;
    readonly getSettings: () => BrowserSettings | Promise<BrowserSettings>;
    readonly options: BrowserOptions;
    private readonly leases;
    private queue;
    private stopped;
    private readonly requestFetch;
    constructor(host: ExternalModuleHost, getSettings: () => BrowserSettings | Promise<BrowserSettings>, options?: BrowserOptions);
    private serial;
    private get ledgerPath();
    private ledger;
    private settings;
    recover(): Promise<void>;
    private deleteRemote;
    private acquire;
    private closeLease;
    run(input: BrowserInput, exec: ModuleExecution): Promise<Record<string, unknown>>;
    close(session: string, exec: ModuleExecution): Promise<Record<string, unknown>>;
    closeForAgent(agent: unknown): Promise<void>;
    status(): Promise<Record<string, unknown>>;
    quiesce(): Promise<void>;
    dispose(): Promise<void>;
}
export declare function registerBrowserTools(service: BrowserService): void;
//# sourceMappingURL=browser.d.ts.map