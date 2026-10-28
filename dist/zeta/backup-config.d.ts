import type { Context } from '@deepseek-ai/cordis';
import { type CredentialRecord } from '@deepseek-ai/dsh-credentials';
export interface PortableConfiguration {
    qq: Record<string, unknown>;
    models: Array<{
        id: string;
        name: string;
        config: Record<string, unknown>;
    }>;
    references: Array<{
        name: string;
        value: string;
    }>;
    records: Array<{
        key: string;
        record: CredentialRecord;
    }>;
    schedule?: {
        deliveryHistoryDays: number;
        deliveryHistoryRecords: number;
    };
    includesCredentials: boolean;
    warnings: string[];
}
/** Read only this plugin and the first-party routes it actually uses. Never enumerate all secrets. */
export declare function exportConfiguration(ctx: Context, qqEffectiveConfig: object, includeCredentials: boolean, signal: AbortSignal, providers?: readonly string[]): Promise<PortableConfiguration>;
/** Validate an untrusted archive without letting it address unrelated plugins or secrets. */
export declare function validateConfiguration(input: unknown, ctx?: Context): PortableConfiguration;
/** Pure admission check for preview: no profile edits, credential writes or restore journal. */
export declare function preflightConfiguration(ctx: Context, input: unknown, signal: AbortSignal): Promise<void>;
/** Restore only admitted credentials; existing different values are never intentionally overwritten. */
export declare function restoreCredentials(ctx: Context, input: PortableConfiguration, signal: AbortSignal): Promise<void>;
export interface RestoreConfigurationOptions {
    dataDir: string;
    cwd: string;
    connectQQ: false;
}
/** Final restore commit: ordinary QQ configuration edits may unload this plugin. */
export declare function restoreConfiguration(ctx: Context, input: PortableConfiguration, options: RestoreConfigurationOptions): Promise<string[]>;
/** Explicit owner action after all restore data has committed. */
export declare function activateConfiguration(ctx: Context): Promise<void>;
//# sourceMappingURL=backup-config.d.ts.map