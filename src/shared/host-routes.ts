import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import type { IncomingMessage, ServerResponse } from 'node:http';

interface Route {
  kind: 'exact' | 'prefix';
  path: string;
  handler(request: IncomingMessage, response: ServerResponse): void | Promise<void>;
}
interface Routes { register(route: Route): () => void }

/** Keep old clients working while all new requests use a proxy-safe namespace. */
export function compatibleRoutePaths(path: string, currentPrefix: string, legacyPrefix: string): string[] {
  if (path !== currentPrefix && !path.startsWith(`${currentPrefix}/`)) throw new Error('兼容路由不属于当前插件前缀');
  return [...new Set([path, `${legacyPrefix}${path.slice(currentPrefix.length)}`])];
}

/** Custom Web routes must explicitly use the Host's admission and owner policy. */
export function ownerRoutes(ctx: Context, server: Routes): Routes {
  return { register: route => server.register({ ...route, handler: async (req, res) => {
    const admission = ctx.connection.admit(req);
    const status = 'rejection' in admission ? admission.rejection : admission.peer.principal.kind === 'owner' ? undefined : 403;
    if (status) {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: status === 401 ? '请从已登录的DSH界面操作' : '当前身份无权管理dsh-feiyu-zeta' }));
      return;
    }
    await route.handler(req, res);
  } }) };
}
