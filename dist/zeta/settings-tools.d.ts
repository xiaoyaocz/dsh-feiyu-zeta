import type { ZetaRuntime } from './runtime.ts';
export declare function mergeSettingsPatch(current: unknown, patch: unknown, depth?: number): unknown;
export declare function registerSettingsTools(runtime: ZetaRuntime, reconcile: () => Promise<unknown>, closeBrowser: () => Promise<void>): void;
//# sourceMappingURL=settings-tools.d.ts.map