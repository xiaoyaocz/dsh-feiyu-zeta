import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
interface Route {
    kind: 'exact' | 'prefix';
    path: string;
    handler(request: IncomingMessage, response: ServerResponse): void | Promise<void>;
}
interface Routes {
    register(route: Route): () => void;
}
/** Custom Web routes must explicitly use the Host's admission and owner policy. */
export declare function ownerRoutes(ctx: Context, server: Routes): Routes;
export {};
//# sourceMappingURL=host-routes.d.ts.map