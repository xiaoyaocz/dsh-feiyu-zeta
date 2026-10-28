import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import type { ConversationBinding, ConversationRecord, SpeechSettings } from './contracts.ts';
export declare const settingsSchema: z.ZodObject<{
    name: z.ZodDefault<z.ZodString>;
    persona: z.ZodDefault<z.ZodString>;
    habits: z.ZodDefault<z.ZodArray<z.ZodString>>;
    security: z.ZodDefault<z.ZodObject<{
        administrators: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    group: z.ZodDefault<z.ZodObject<{
        waitMs: z.ZodDefault<z.ZodNumber>;
        maxWaitMs: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    browser: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        accountId: z.ZodDefault<z.ZodString>;
        maxConcurrent: z.ZodDefault<z.ZodNumber>;
        maxSessionMs: z.ZodDefault<z.ZodNumber>;
        idleTimeoutMs: z.ZodDefault<z.ZodNumber>;
        dailyBudgetMs: z.ZodDefault<z.ZodNumber>;
        actionTimeoutMs: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    images: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        model: z.ZodDefault<z.ZodLiteral<"gemini-nano-banana-2.1-ext">>;
        resolution: z.ZodDefault<z.ZodEnum<{
            "1K": "1K";
            "2K": "2K";
            "4K": "4K";
        }>>;
        timeoutMs: z.ZodDefault<z.ZodNumber>;
        pollIntervalMs: z.ZodDefault<z.ZodNumber>;
        maxWaitMs: z.ZodDefault<z.ZodNumber>;
        maxPromptCharacters: z.ZodDefault<z.ZodNumber>;
        maxImageBytes: z.ZodDefault<z.ZodNumber>;
        dailyLimit: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    deployments: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        acceptedTerms: z.ZodDefault<z.ZodBoolean>;
        maxFiles: z.ZodDefault<z.ZodNumber>;
        maxFileBytes: z.ZodDefault<z.ZodNumber>;
        maxTotalBytes: z.ZodDefault<z.ZodNumber>;
        timeoutMs: z.ZodDefault<z.ZodNumber>;
        maxActive: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    conversations: z.ZodDefault<z.ZodObject<{
        allowCrossSend: z.ZodDefault<z.ZodBoolean>;
        allowCrossRead: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    memory: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        maxItems: z.ZodDefault<z.ZodNumber>;
        maxValueChars: z.ZodDefault<z.ZodNumber>;
        injectItems: z.ZodDefault<z.ZodNumber>;
        injectChars: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    speech: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        provider: z.ZodDefault<z.ZodEnum<{
            mimo: "mimo";
            minimax: "minimax";
        }>>;
        mimo: z.ZodDefault<z.ZodObject<{
            model: z.ZodString;
            voice: z.ZodString;
            speed: z.ZodNumber;
            emotion: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        minimax: z.ZodDefault<z.ZodObject<{
            model: z.ZodString;
            voice: z.ZodString;
            speed: z.ZodNumber;
            emotion: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        maxTextCharacters: z.ZodDefault<z.ZodNumber>;
        timeoutMs: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    life: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        intervalMinutes: z.ZodDefault<z.ZodNumber>;
        minIntervalMinutes: z.ZodDefault<z.ZodNumber>;
        maxDailyRuns: z.ZodDefault<z.ZodNumber>;
        timeZone: z.ZodDefault<z.ZodString>;
        quietStart: z.ZodDefault<z.ZodNumber>;
        quietEnd: z.ZodDefault<z.ZodNumber>;
        targets: z.ZodDefault<z.ZodArray<z.ZodString>>;
        readTargets: z.ZodDefault<z.ZodArray<z.ZodString>>;
        allowContact: z.ZodDefault<z.ZodBoolean>;
        allowMemes: z.ZodDefault<z.ZodBoolean>;
        allowSpeech: z.ZodDefault<z.ZodBoolean>;
        dailyContactLimit: z.ZodDefault<z.ZodNumber>;
        contactCooldownMinutes: z.ZodDefault<z.ZodNumber>;
        interests: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strict>;
export type ZetaSettings = z.infer<typeof settingsSchema>;
export declare const defaultSettings: () => ZetaSettings;
declare const identityProfileSchema: z.ZodObject<{
    name: z.ZodString;
    persona: z.ZodString;
    habits: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export type IdentityProfile = z.infer<typeof identityProfileSchema>;
declare const identityRecordSchema: z.ZodObject<{
    current: z.ZodObject<{
        name: z.ZodString;
        persona: z.ZodString;
        habits: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    revision: z.ZodNumber;
    updatedAt: z.ZodString;
    history: z.ZodArray<z.ZodObject<{
        revision: z.ZodNumber;
        reason: z.ZodString;
        createdAt: z.ZodString;
        sourceSessionId: z.ZodOptional<z.ZodString>;
        before: z.ZodObject<{
            name: z.ZodString;
            persona: z.ZodString;
            habits: z.ZodArray<z.ZodString>;
        }, z.core.$strict>;
        after: z.ZodObject<{
            name: z.ZodString;
            persona: z.ZodString;
            habits: z.ZodArray<z.ZodString>;
        }, z.core.$strict>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type IdentityRecord = z.infer<typeof identityRecordSchema>;
export type IdentityView = IdentityProfile & Omit<IdentityRecord, 'current'>;
export declare const identityUpdateSchema: z.ZodObject<{
    expected_revision: z.ZodNumber;
    reason: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    persona: z.ZodOptional<z.ZodString>;
    habits: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export type IdentityUpdate = z.infer<typeof identityUpdateSchema>;
interface IdentityWriteContext {
    sourceSessionId?: string;
    signal?: AbortSignal;
    beforeCommit?: () => void;
}
interface SettingsWriteOptions {
    expectedIdentityRevision?: number;
    preserveIdentity?: boolean;
    reason?: string;
}
declare const memorySchema: z.ZodObject<{
    key: z.ZodString;
    value: z.ZodString;
    tags: z.ZodArray<z.ZodString>;
    pinned: z.ZodBoolean;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
    sourceSessionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type MemoryEntry = z.infer<typeof memorySchema>;
export declare const PUBLIC_SPACE = "self:zeta";
declare const userSchema: z.ZodObject<{
    appId: z.ZodString;
    senderId: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    scope: z.ZodEnum<{
        c2c: "c2c";
        group: "group";
    }>;
    peerId: z.ZodString;
    lastSeenAt: z.ZodNumber;
}, z.core.$strict>;
/** Platform-observed sender identity; display names never grant permissions. */
export type UserRecord = z.infer<typeof userSchema>;
export interface UserObservation {
    appId: string;
    senderId: string;
    name?: string;
    scope: 'c2c' | 'group';
    peerId: string;
    seenAt?: number;
}
declare const lifeSchema: z.ZodObject<{
    nextWakeAt: z.ZodOptional<z.ZodNumber>;
    nextWakeReason: z.ZodDefault<z.ZodString>;
    planRevision: z.ZodDefault<z.ZodNumber>;
    runId: z.ZodOptional<z.ZodString>;
    claimedRunId: z.ZodOptional<z.ZodString>;
    runDay: z.ZodDefault<z.ZodString>;
    runCount: z.ZodDefault<z.ZodNumber>;
    planningInitialized: z.ZodDefault<z.ZodBoolean>;
    sessionId: z.ZodOptional<z.ZodString>;
    scheduleId: z.ZodOptional<z.ZodString>;
    intervalMinutes: z.ZodOptional<z.ZodNumber>;
    lastRunAt: z.ZodDefault<z.ZodNumber>;
    lastFinishedAt: z.ZodDefault<z.ZodNumber>;
    status: z.ZodDefault<z.ZodEnum<{
        disabled: "disabled";
        idle: "idle";
        running: "running";
        error: "error";
    }>>;
    summary: z.ZodDefault<z.ZodString>;
    focus: z.ZodDefault<z.ZodString>;
    error: z.ZodOptional<z.ZodString>;
    contactDay: z.ZodDefault<z.ZodString>;
    contactCount: z.ZodDefault<z.ZodNumber>;
    contacts: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodNumber>>;
}, z.core.$strip>;
export type LifeState = z.infer<typeof lifeSchema>;
declare const effectSchema: z.ZodObject<{
    status: z.ZodEnum<{
        failed: "failed";
        unknown: "unknown";
        pending: "pending";
        succeeded: "succeeded";
    }>;
    kind: z.ZodString;
    target: z.ZodString;
    createdAt: z.ZodNumber;
    result: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    error: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type EffectRecord = z.infer<typeof effectSchema>;
declare const migrationSchema: z.ZodObject<{
    backupId: z.ZodString;
    backupDigest: z.ZodDefault<z.ZodString>;
    status: z.ZodEnum<{
        restoring: "restoring";
        complete: "complete";
    }>;
    dataRoot: z.ZodString;
    workspaceRoot: z.ZodString;
    restartRequired: z.ZodBoolean;
    qqPaused: z.ZodBoolean;
    activationPending: z.ZodDefault<z.ZodBoolean>;
    pathMappings: z.ZodRecord<z.ZodString, z.ZodString>;
    pendingSchedules: z.ZodDefault<z.ZodArray<z.ZodUnknown>>;
    groupBuffers: z.ZodDefault<z.ZodArray<z.ZodUnknown>>;
    error: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type MigrationState = z.infer<typeof migrationSchema>;
export declare const zetaSnapshotSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    tables: z.ZodObject<{
        settings: z.ZodRecord<z.ZodString, z.ZodObject<{
            name: z.ZodDefault<z.ZodString>;
            persona: z.ZodDefault<z.ZodString>;
            habits: z.ZodDefault<z.ZodArray<z.ZodString>>;
            security: z.ZodDefault<z.ZodObject<{
                administrators: z.ZodDefault<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
            group: z.ZodDefault<z.ZodObject<{
                waitMs: z.ZodDefault<z.ZodNumber>;
                maxWaitMs: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strict>>;
            browser: z.ZodDefault<z.ZodObject<{
                enabled: z.ZodDefault<z.ZodBoolean>;
                accountId: z.ZodDefault<z.ZodString>;
                maxConcurrent: z.ZodDefault<z.ZodNumber>;
                maxSessionMs: z.ZodDefault<z.ZodNumber>;
                idleTimeoutMs: z.ZodDefault<z.ZodNumber>;
                dailyBudgetMs: z.ZodDefault<z.ZodNumber>;
                actionTimeoutMs: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strict>>;
            images: z.ZodDefault<z.ZodObject<{
                enabled: z.ZodDefault<z.ZodBoolean>;
                model: z.ZodDefault<z.ZodLiteral<"gemini-nano-banana-2.1-ext">>;
                resolution: z.ZodDefault<z.ZodEnum<{
                    "1K": "1K";
                    "2K": "2K";
                    "4K": "4K";
                }>>;
                timeoutMs: z.ZodDefault<z.ZodNumber>;
                pollIntervalMs: z.ZodDefault<z.ZodNumber>;
                maxWaitMs: z.ZodDefault<z.ZodNumber>;
                maxPromptCharacters: z.ZodDefault<z.ZodNumber>;
                maxImageBytes: z.ZodDefault<z.ZodNumber>;
                dailyLimit: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strict>>;
            deployments: z.ZodDefault<z.ZodObject<{
                enabled: z.ZodDefault<z.ZodBoolean>;
                acceptedTerms: z.ZodDefault<z.ZodBoolean>;
                maxFiles: z.ZodDefault<z.ZodNumber>;
                maxFileBytes: z.ZodDefault<z.ZodNumber>;
                maxTotalBytes: z.ZodDefault<z.ZodNumber>;
                timeoutMs: z.ZodDefault<z.ZodNumber>;
                maxActive: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strict>>;
            conversations: z.ZodDefault<z.ZodObject<{
                allowCrossSend: z.ZodDefault<z.ZodBoolean>;
                allowCrossRead: z.ZodDefault<z.ZodBoolean>;
            }, z.core.$strip>>;
            memory: z.ZodDefault<z.ZodObject<{
                enabled: z.ZodDefault<z.ZodBoolean>;
                maxItems: z.ZodDefault<z.ZodNumber>;
                maxValueChars: z.ZodDefault<z.ZodNumber>;
                injectItems: z.ZodDefault<z.ZodNumber>;
                injectChars: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strip>>;
            speech: z.ZodDefault<z.ZodObject<{
                enabled: z.ZodDefault<z.ZodBoolean>;
                provider: z.ZodDefault<z.ZodEnum<{
                    mimo: "mimo";
                    minimax: "minimax";
                }>>;
                mimo: z.ZodDefault<z.ZodObject<{
                    model: z.ZodString;
                    voice: z.ZodString;
                    speed: z.ZodNumber;
                    emotion: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>;
                minimax: z.ZodDefault<z.ZodObject<{
                    model: z.ZodString;
                    voice: z.ZodString;
                    speed: z.ZodNumber;
                    emotion: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>;
                maxTextCharacters: z.ZodDefault<z.ZodNumber>;
                timeoutMs: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strip>>;
            life: z.ZodDefault<z.ZodObject<{
                enabled: z.ZodDefault<z.ZodBoolean>;
                intervalMinutes: z.ZodDefault<z.ZodNumber>;
                minIntervalMinutes: z.ZodDefault<z.ZodNumber>;
                maxDailyRuns: z.ZodDefault<z.ZodNumber>;
                timeZone: z.ZodDefault<z.ZodString>;
                quietStart: z.ZodDefault<z.ZodNumber>;
                quietEnd: z.ZodDefault<z.ZodNumber>;
                targets: z.ZodDefault<z.ZodArray<z.ZodString>>;
                readTargets: z.ZodDefault<z.ZodArray<z.ZodString>>;
                allowContact: z.ZodDefault<z.ZodBoolean>;
                allowMemes: z.ZodDefault<z.ZodBoolean>;
                allowSpeech: z.ZodDefault<z.ZodBoolean>;
                dailyContactLimit: z.ZodDefault<z.ZodNumber>;
                contactCooldownMinutes: z.ZodDefault<z.ZodNumber>;
                interests: z.ZodDefault<z.ZodString>;
            }, z.core.$strip>>;
        }, z.core.$strict>>;
        memories: z.ZodRecord<z.ZodString, z.ZodObject<{
            revision: z.ZodNumber;
            entries: z.ZodArray<z.ZodObject<{
                key: z.ZodString;
                value: z.ZodString;
                tags: z.ZodArray<z.ZodString>;
                pinned: z.ZodBoolean;
                createdAt: z.ZodString;
                updatedAt: z.ZodString;
                sourceSessionId: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>;
            mergeReceipts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
                space: z.ZodString;
                revision: z.ZodNumber;
                digest: z.ZodString;
            }, z.core.$strip>>>;
        }, z.core.$strip>>;
        bindings: z.ZodRecord<z.ZodString, z.ZodObject<{
            key: z.ZodString;
            appId: z.ZodString;
            scope: z.ZodEnum<{
                c2c: "c2c";
                group: "group";
            }>;
            peerId: z.ZodString;
            sessionId: z.ZodString;
            title: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        life: z.ZodRecord<z.ZodString, z.ZodObject<{
            nextWakeAt: z.ZodOptional<z.ZodNumber>;
            nextWakeReason: z.ZodDefault<z.ZodString>;
            planRevision: z.ZodDefault<z.ZodNumber>;
            runId: z.ZodOptional<z.ZodString>;
            claimedRunId: z.ZodOptional<z.ZodString>;
            runDay: z.ZodDefault<z.ZodString>;
            runCount: z.ZodDefault<z.ZodNumber>;
            planningInitialized: z.ZodDefault<z.ZodBoolean>;
            sessionId: z.ZodOptional<z.ZodString>;
            scheduleId: z.ZodOptional<z.ZodString>;
            intervalMinutes: z.ZodOptional<z.ZodNumber>;
            lastRunAt: z.ZodDefault<z.ZodNumber>;
            lastFinishedAt: z.ZodDefault<z.ZodNumber>;
            status: z.ZodDefault<z.ZodEnum<{
                disabled: "disabled";
                idle: "idle";
                running: "running";
                error: "error";
            }>>;
            summary: z.ZodDefault<z.ZodString>;
            focus: z.ZodDefault<z.ZodString>;
            error: z.ZodOptional<z.ZodString>;
            contactDay: z.ZodDefault<z.ZodString>;
            contactCount: z.ZodDefault<z.ZodNumber>;
            contacts: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodNumber>>;
        }, z.core.$strip>>;
        effects: z.ZodRecord<z.ZodString, z.ZodObject<{
            status: z.ZodEnum<{
                failed: "failed";
                unknown: "unknown";
                pending: "pending";
                succeeded: "succeeded";
            }>;
            kind: z.ZodString;
            target: z.ZodString;
            createdAt: z.ZodNumber;
            result: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            error: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        conversations: z.ZodRecord<z.ZodString, z.ZodObject<{
            key: z.ZodString;
            appId: z.ZodString;
            scope: z.ZodEnum<{
                c2c: "c2c";
                group: "group";
            }>;
            peerId: z.ZodString;
            target: z.ZodString;
            title: z.ZodOptional<z.ZodString>;
            alias: z.ZodOptional<z.ZodString>;
            sessionId: z.ZodOptional<z.ZodString>;
            lastSeenAt: z.ZodNumber;
            active: z.ZodBoolean;
            activeObservedAt: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
        identity: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
            current: z.ZodObject<{
                name: z.ZodString;
                persona: z.ZodString;
                habits: z.ZodArray<z.ZodString>;
            }, z.core.$strict>;
            revision: z.ZodNumber;
            updatedAt: z.ZodString;
            history: z.ZodArray<z.ZodObject<{
                revision: z.ZodNumber;
                reason: z.ZodString;
                createdAt: z.ZodString;
                sourceSessionId: z.ZodOptional<z.ZodString>;
                before: z.ZodObject<{
                    name: z.ZodString;
                    persona: z.ZodString;
                    habits: z.ZodArray<z.ZodString>;
                }, z.core.$strict>;
                after: z.ZodObject<{
                    name: z.ZodString;
                    persona: z.ZodString;
                    habits: z.ZodArray<z.ZodString>;
                }, z.core.$strict>;
            }, z.core.$strict>>;
        }, z.core.$strict>>>;
        users: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
            appId: z.ZodString;
            senderId: z.ZodString;
            name: z.ZodOptional<z.ZodString>;
            scope: z.ZodEnum<{
                c2c: "c2c";
                group: "group";
            }>;
            peerId: z.ZodString;
            lastSeenAt: z.ZodNumber;
        }, z.core.$strict>>>;
    }, z.core.$strict>;
}, z.core.$strict>;
export type ZetaSnapshot = z.infer<typeof zetaSnapshotSchema>;
export declare const spaceDirectory: (space: string) => string;
export declare function qqMemorySpace(appId: string, scope: 'c2c' | 'group', peerId: string): string;
/** One DSH domain handle owns state; no parallel database or runtime log. */
export declare class ZetaState {
    private readonly domain;
    private constructor();
    static open(ctx: Context): Promise<ZetaState>;
    get settings(): ZetaSettings;
    get identity(): IdentityView;
    private settingsChain;
    private serializeSettings;
    private commitIdentity;
    updateIdentity(input: IdentityUpdate, context?: IdentityWriteContext): Promise<IdentityView>;
    resetIdentity(expectedRevision?: number): Promise<IdentityView>;
    setSettings(value: unknown, options?: SettingsWriteOptions): Promise<ZetaSettings>;
    get speech(): SpeechSettings;
    bindings(): ConversationBinding[];
    binding(sessionId: string): ConversationBinding | undefined;
    bind(binding: ConversationBinding): Promise<void>;
    conversations(appId?: string): ConversationRecord[];
    users(appId?: string): UserRecord[];
    observeUser(input: UserObservation): Promise<UserRecord>;
    observeConversation(input: {
        appId: string;
        scope: 'c2c' | 'group';
        peerId: string;
        title?: string;
        sessionId?: string;
        active?: boolean;
        seenAt?: number;
    }): Promise<ConversationRecord>;
    renameConversation(appId: string, destination: string, alias: string): Promise<ConversationRecord>;
    /** Copy and receipt must commit before old rows are removed, so interrupted cleanup is safe to resume. */
    private mergeLegacyMemories;
    spaces(): Array<{
        key: string;
        count: number;
        revision: number;
    }>;
    listMemory(_space: string, query?: string): MemoryEntry[];
    private ensureSpace;
    private memoryChain;
    private serial;
    setMemory(_space: string, input: {
        key: string;
        value: string;
        tags?: string[];
        pinned?: boolean;
        sourceSessionId?: string;
        expectedUpdatedAt?: string;
    }): Promise<MemoryEntry>;
    deleteMemory(_space: string, key: string): Promise<boolean>;
    memoryContext(_space: string): string;
    get life(): LifeState;
    updateLife(fn: (current: LifeState) => LifeState): Promise<LifeState>;
    effect(id: string): EffectRecord | undefined;
    putEffect(id: string, effect: EffectRecord): Promise<void>;
    get migration(): MigrationState | undefined;
    setMigration(value: z.input<typeof migrationSchema>): Promise<void>;
    consumeMigrationGroup(appId: string, peerId: string): Promise<void>;
    snapshot(): Promise<ZetaSnapshot>;
    restoreSnapshot(snapshot: ZetaSnapshot): Promise<void>;
    close(): Promise<void>;
}
export {};
//# sourceMappingURL=state.d.ts.map