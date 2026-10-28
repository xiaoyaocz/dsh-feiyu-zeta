import type { ModuleExecution } from './contracts.ts';
import { type ExternalModuleHost } from './browser.ts';
export interface DeploymentSettings {
    enabled: boolean;
    acceptedTerms: boolean;
    maxFiles: number;
    maxFileBytes: number;
    maxTotalBytes: number;
    timeoutMs: number;
    maxActive: number;
}
export declare const DEFAULT_DEPLOYMENT_SETTINGS: DeploymentSettings;
export interface DeploymentFile {
    path: string;
    content: string;
    encoding?: 'utf8' | 'base64';
}
export interface DeploymentInput {
    files: DeploymentFile[];
    id?: string;
    title?: string;
}
export interface DeploymentResult {
    id: string;
    title: string;
    status: 'preparing' | 'deploying' | 'ready' | 'failed' | 'unknown' | 'deleted' | 'expired';
    previewUrl?: string;
    createdAt: string;
    expiresAt?: string;
    fileCount: number;
    bytes: number;
    notice?: string;
}
export interface DeploymentSecrets {
    set(id: string, value: string): Promise<void>;
    get(id: string): Promise<string | undefined>;
    delete(id: string): Promise<void>;
}
export interface PreviewChallenge {
    challengeToken: string;
    seed: string;
    k: number;
    g: number;
}
export interface DeploymentOptions {
    fetch?: typeof fetch;
    secrets?: DeploymentSecrets;
    solveChallenge?: (challenge: PreviewChallenge, signal: AbortSignal) => Promise<{
        challengeToken: string;
        solution: {
            checkpoints: string;
        };
    }>;
    beforeDeploy?: (input: DeploymentInput, exec: ModuleExecution) => void | Promise<void>;
}
/** Cloudflare's documented bounded SHA-256 checkpoint proof, off the event loop. */
export declare function solvePreviewChallenge(challenge: PreviewChallenge, signal: AbortSignal): Promise<{
    challengeToken: string;
    solution: {
        checkpoints: string;
    };
}>;
export declare class DeploymentService {
    readonly host: ExternalModuleHost;
    readonly getSettings: () => DeploymentSettings | Promise<DeploymentSettings>;
    readonly options: DeploymentOptions;
    private readonly requestFetch;
    private readonly running;
    private readonly controllers;
    private readonly pendingWrites;
    private readonly expirations;
    private queue;
    private stopped;
    constructor(host: ExternalModuleHost, getSettings: () => DeploymentSettings | Promise<DeploymentSettings>, options?: DeploymentOptions);
    private get directory();
    private path;
    private serial;
    private public;
    private load;
    private settings;
    private files;
    private api;
    private secret;
    private expire;
    private scheduleExpiry;
    recover(): Promise<void>;
    deploy(input: DeploymentInput, exec: ModuleExecution): Promise<DeploymentResult>;
    private deployOnce;
    status(id: string, exec: ModuleExecution): Promise<DeploymentResult>;
    list(agent: unknown): Promise<DeploymentResult[]>;
    /** Authenticated administrator API only. Never register as a model tool. */
    claim(id: string): Promise<{
        claimUrl: string;
        expiresAt: string;
    }>;
    remove(id: string, exec: ModuleExecution): Promise<DeploymentResult>;
    quiesce(): Promise<void>;
    dispose(): Promise<void>;
}
export declare function registerDeploymentTools(service: DeploymentService): void;
//# sourceMappingURL=deployments.d.ts.map