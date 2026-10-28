import type { ModuleExecution, ModuleHost, SpeechSettings } from './contracts.ts';
export declare const SPEECH_TOOL_NAME = "zeta_speech_generate";
export declare const SPEECH_LIST_TOOL_NAME = "zeta_speech_list";
export declare const SPEECH_SEND_TOOL_NAME = "zeta_speech_send";
export declare const SPEECH_ENDPOINTS: {
    readonly mimo: "https://api.xiaomimimo.com/v1/chat/completions";
    readonly minimax: "https://api.minimax.cn/v1/t2a_v2";
};
export interface SpeechArguments {
    text: string;
    provider?: 'mimo' | 'minimax';
    voice?: string;
    speed?: number;
    emotion?: string;
    send?: boolean;
    target?: string;
}
export interface SpeechRequest {
    provider: 'mimo' | 'minimax';
    text: string;
    model: string;
    voice: string;
    speed: number;
    emotion?: string;
    apiKey: string;
    timeoutMs: number;
}
export interface SpeechAudio {
    audio: Buffer;
    mimeType: 'audio/wav';
    providerRequestId?: string;
}
export interface SpeechResult {
    provider: 'mimo' | 'minimax';
    model: string;
    voice: string;
    filePath: string;
    fileName: string;
    mimeType: 'audio/wav';
    bytes: number;
    characters: number;
    createdAt: string;
    generation: 'completed';
    delivery: 'not_requested' | 'sent' | 'failed' | 'unknown';
    /** Only platform evidence may populate the actual delivery target. */
    target?: string;
    requestedTarget?: string;
    reused?: boolean;
    receipt?: Record<string, unknown>;
    notice?: string;
}
export declare class SpeechError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export interface SpeechModuleOptions {
    /** Gate autonomous costs/targets before any provider request is submitted. */
    beforeGenerate?: (args: SpeechArguments, exec: ModuleExecution) => void | Promise<void>;
    fetch?: typeof fetch;
}
export interface SpeechSendArguments {
    fileName: string;
    target: string;
}
export declare function validateSpeechArguments(value: unknown, settings: SpeechSettings): SpeechArguments;
/** Exactly one provider POST; all errors omit provider response text and credentials. */
export declare function synthesizeSpeech(request: SpeechRequest, signal: AbortSignal, requestFetch?: typeof fetch): Promise<SpeechAudio>;
/** Send a verified library file without another provider request or credential read. */
export declare function sendSpeech(host: ModuleHost, input: unknown, exec: ModuleExecution): Promise<SpeechResult>;
/** Request-scoped synthesis identity prevents repeated charges across model call ids. */
export declare function generateSpeech(host: ModuleHost, settings: SpeechSettings, input: unknown, exec: ModuleExecution, options?: SpeechModuleOptions): Promise<SpeechResult>;
/** Read-only metadata for the authenticated management UI, scoped by the host. */
export declare function listSpeechFiles(host: ModuleHost, agent: unknown, limit?: number): Promise<SpeechResult[]>;
export declare function registerSpeechTools(host: ModuleHost, getSettings: () => SpeechSettings | Promise<SpeechSettings>, options?: SpeechModuleOptions): void;
//# sourceMappingURL=speech.d.ts.map