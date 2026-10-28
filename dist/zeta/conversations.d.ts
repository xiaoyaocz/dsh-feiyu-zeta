import { type SessionEvent } from '@deepseek-ai/dsh-session';
import type { ModuleExecution } from './contracts.ts';
import type { ZetaRuntime } from './runtime.ts';
interface ReadArgs {
    target: string;
    limit?: number;
    beforeSeq?: number;
}
interface ChatPreview {
    role: 'user' | 'assistant';
    time: number;
    seq: number;
    text: string;
    truncated?: boolean;
}
/** Read user-visible text only; tool output, system prompts and synthetic wakes stay out. */
export declare function previewSession(events: readonly SessionEvent[], limit: number, beforeSeq: number | undefined, signal: AbortSignal): {
    messages: ChatPreview[];
    hasMore: boolean;
    nextBeforeSeq?: number;
    characters: number;
};
export declare function readConversation(runtime: ZetaRuntime, args: ReadArgs, exec: ModuleExecution): Promise<unknown>;
export declare function registerConversationTools(runtime: ZetaRuntime): void;
export {};
//# sourceMappingURL=conversations.d.ts.map