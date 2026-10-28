import type { Context } from '@deepseek-ai/cordis';
import type { SessionManager } from '../session/session-manager.ts';
import type { SessionRecord } from '../session/types.ts';
import type { QQBotSender } from '../transport/outbound-buffer.ts';
import type { MediaSenderLike } from '../media/send-media.ts';
import type { AccessControlConfig } from '../config.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { ConversationBinding, ConversationRecord, ModuleHost } from './contracts.ts';
import { ZetaState } from './state.ts';
import { type RequestAuthority, type RequestSource } from './permissions.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        projectZeta: ZetaRuntime;
    }
}
interface Gateway {
    manager: SessionManager;
    sender: QQBotSender;
    mediaSender: MediaSenderLike;
}
type CredentialProvider = 'mimo' | 'minimax' | 'cloudflare' | 'apimart';
export declare function within(file: string, root: string): boolean;
export declare function dayInZone(timeZone: string, now?: Date): string;
export declare function quietNow(start: number, end: number, timeZone: string, now?: Date): boolean;
export declare class ZetaRuntime implements ModuleHost {
    readonly ctx: Context;
    readonly state: ZetaState;
    appId: string;
    private gateway?;
    private readonly calls;
    private readonly attachments;
    private readonly requests;
    private readonly securedAgents;
    private readonly scopedDisposers;
    private readonly managementAgents;
    private sendChain;
    private fileRoots;
    private access?;
    private qqConfiguration?;
    private maintenanceGate?;
    private restartLock;
    private readonly writeOperations;
    private readonly maintenanceCleanups;
    readonly dataDir: string;
    readonly selfSpace = "self:zeta";
    constructor(ctx: Context, state: ZetaState, appId: string, directory?: string);
    attachGateway(gateway: Gateway, appId?: string): void;
    configureFileRoots(roots: string[]): void;
    configureQQ(config: ImQQBotConfig): void;
    exportQQConfiguration(): Record<string, unknown>;
    get maintenance(): boolean;
    requireWritable(): void;
    beginWriteOperation(controller: AbortController): () => void;
    onMaintenance(cleanup: () => Promise<void>): () => void;
    waitForMaintenance(signal?: AbortSignal): Promise<void>;
    withMaintenance<T>(work: () => Promise<T>, lockAfter?: boolean): Promise<T>;
    configureAccess(access: AccessControlConfig): void;
    private allowsConversation;
    bindRecord(record: SessionRecord): Promise<void>;
    private secureAgent;
    beginRequest(agent: unknown, sources: readonly RequestSource[], group: boolean): void;
    endRequest(agent: unknown): void;
    authorityFor(agent: unknown): RequestAuthority | undefined;
    isAdministrator(senderId: string): boolean;
    canApprove(agent: unknown, senderId?: string): boolean;
    private lifeImageDenial;
    private denialFor;
    decideGroup(agent: unknown, decision: 'reply' | 'skip'): {
        decision: 'reply' | 'skip';
        sendsMessage: false;
    };
    private requireGroupReply;
    bindingFor(agent: unknown): ConversationBinding | undefined;
    isLifeAgent(agent: unknown): boolean;
    isIdentityActor(agent: unknown): boolean;
    managementAgent(_legacySpace?: string): object;
    spaceFor(agent: unknown): string;
    directoryFor(agent: unknown, kind: 'speech' | 'memes'): Promise<string>;
    noteAttachments(agent: unknown, files: string[]): void;
    allowedInputFiles(agent: unknown): string[];
    conversations(): ConversationRecord[];
    conversation(target: string): ConversationRecord;
    private requireConversationActor;
    readableConversation(agent: unknown, target: string): ConversationRecord;
    contactTargets(agent: unknown): Array<ConversationRecord & {
        current: boolean;
        canRead: boolean;
        canSend: boolean;
        sendBlockedReason?: string;
    }>;
    resolveApiKey(provider: 'mimo' | 'minimax'): Promise<string>;
    credentialStatus(): Promise<Record<string, boolean>>;
    resolveServiceKey(provider: 'cloudflare' | 'apimart'): Promise<string>;
    setCredential(provider: CredentialProvider, value: string | null): Promise<void>;
    targetFor(agent: unknown, target?: string, kind?: 'text' | 'speech' | 'memes' | 'file'): ConversationBinding;
    private effect;
    private serialSend;
    sendText(agent: unknown, text: string, target: string | undefined, signal: AbortSignal): Promise<Record<string, unknown>>;
    sendFile(agent: unknown, absolutePath: string, target: string | undefined, signal: AbortSignal): Promise<Record<string, unknown>>;
    install(): void;
    get legacyMediaRoot(): string;
}
export {};
//# sourceMappingURL=runtime.d.ts.map