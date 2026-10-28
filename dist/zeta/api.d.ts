import type { Context } from '@deepseek-ai/cordis';
import type { ZetaRuntime } from './runtime.ts';
import type { MemeModule } from './memes.ts';
import type { ZetaState } from './state.ts';
import type { BackupService } from './backup.ts';
import type { ZetaServices } from './services.ts';
interface LifeControl {
    reconcile(): Promise<unknown>;
    runNow(): Promise<unknown>;
    stop(): Promise<unknown>;
    status(): unknown;
}
export interface AdministratorCandidate {
    senderId: string;
    name?: string;
    scope?: 'c2c' | 'group';
    peerId?: string;
    lastSeenAt: number;
    observed: boolean;
}
/** Runs inside the authenticated DSH HTTP service; never starts a parallel server. */
export declare function registerZetaApi(ctx: Context, runtime: ZetaRuntime, state: ZetaState, memes: MemeModule, life: LifeControl, backup?: BackupService, services?: ZetaServices): void;
export {};
//# sourceMappingURL=api.d.ts.map