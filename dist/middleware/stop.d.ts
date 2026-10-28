import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { SessionManager } from '../session/index.ts';
/** Match a whole stop request, never quoted discussion or a request to continue. */
export declare function isNaturalStop(text: string, appId?: string): boolean;
export declare function naturalStop(manager: SessionManager, cancelQueued?: (scope: 'c2c' | 'group', peerId: string) => void): (ctx: MiddlewareContext, next: () => Promise<void>) => Promise<void>;
//# sourceMappingURL=stop.d.ts.map