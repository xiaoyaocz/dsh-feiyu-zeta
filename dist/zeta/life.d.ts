import type { Context } from '@deepseek-ai/cordis';
import type { ModuleHost } from './contracts.ts';
import type { LifeState, ZetaState } from './state.ts';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'zeta-life': {
            kind: 'zeta-life';
            mode: 'manual';
            runId?: string;
        };
        schedule: {
            kind: 'schedule';
        };
    }
}
export declare const lifeInstructions: string;
export declare class LifeError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function isLifeQuietTime(now: number, timeZone: string, start: number, end: number): boolean;
/** One durable internal Session and at most one active, AI-planned one-shot. */
export declare class LifeController {
    private readonly ctx;
    private readonly state;
    private readonly host;
    private readonly disposers;
    private readonly acceptedTurns;
    private management;
    private pending;
    private disposed;
    constructor(ctx: Context, state: ZetaState, host: ModuleHost);
    private requireInternal;
    private observe;
    private serialize;
    private isInternal;
    private allowedTime;
    private preStep;
    private requireModel;
    private schedule;
    private ensureSession;
    private owned;
    private recordError;
    private reconcileInside;
    reconcile(): Promise<void>;
    runNow(): Promise<unknown>;
    private deactivate;
    stop(): Promise<void>;
    status(): LifeState & {
        enabled: boolean;
    };
    contextText(): string;
    dispose(): Promise<void>;
}
export declare function registerLife(ctx: Context, state: ZetaState, host: ModuleHost): LifeController;
//# sourceMappingURL=life.d.ts.map