import { Context } from '@deepseek-ai/cordis';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerZetaApi } from './api.ts';
import type { ZetaRuntime } from './runtime.ts';
import type { ZetaState } from './state.ts';
import type { MemeModule } from './memes.ts';
import { LEGACY_ZETA_API_PATH, ZETA_API_PATH } from '../shared/http-paths.ts';

interface Route {
  kind: 'prefix'; path: string;
  handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>;
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe('management routes follow actual Cordis service lifecycles', () => {
  it('waits for late services, registers both prefixes and replaces/cleans their scoped routes', async () => {
    const app = new Context();
    const identity = { name: 'fixture whale', persona: 'fixture persona', habits: [], revision: 2, updatedAt: '2026-01-01T00:00:00.000Z', history: [] };
    const state = { identity } as unknown as ZetaState;
    const runtime = { selfSpace: 'self:zeta' } as unknown as ZetaRuntime;
    const life = { reconcile: async () => {}, runNow: async () => {}, stop: async () => {}, status: () => ({ status: 'disabled' }) };
    let activeRoutes = new Map<string, Route>();
    const webServer = createServer((req, res) => {
      const path = new URL(req.url || '/', 'http://fixture.local').pathname;
      // Match the carrier's prefix dispatch, including paths the API must reject.
      const route = [...activeRoutes.values()].find(item => path.startsWith(item.path));
      if (route) void route.handler(req, res); else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(done => webServer.listen(0, '127.0.0.1', done));
    cleanup.push(async () => { webServer.closeAllConnections(); await new Promise<void>(done => webServer.close(() => done())); });
    const base = `http://127.0.0.1:${(webServer.address() as AddressInfo).port}`;
    const owner = app.plugin({ name: 'zeta-api-owner-fixture', apply(ctx: Context) { registerZetaApi(ctx, runtime, state, {} as MemeModule, life); } });
    cleanup.push(() => owner.dispose());
    await owner.await();
    expect(activeRoutes.size).toBe(0);

    function provideWeb(routes: Map<string, Route>) {
      const provider = app.plugin({ name: 'web-server-fixture', apply(ctx: Context) {
        ctx.provide('webServer', { register: (route: Route) => { routes.set(route.path, route); return () => { routes.delete(route.path); }; } });
      } });
      cleanup.push(() => provider.dispose()); return provider;
    }
    const first = activeRoutes;
    const provider = provideWeb(first); await provider.await();
    expect(first.size).toBe(0); // Connection admission is required independently.
    const connection = app.plugin({ name: 'connection-fixture', apply(ctx: Context) {
      ctx.provide('connection', { admit: (req: IncomingMessage) => req.headers['x-owner'] === 'yes'
        ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 } });
    } });
    cleanup.push(() => connection.dispose()); await connection.await();
    await vi.waitFor(() => expect(first.size).toBe(2));
    for (const prefix of [ZETA_API_PATH, LEGACY_ZETA_API_PATH]) {
      const response = await fetch(`${base}${prefix}/identity`, { headers: { 'x-owner': 'yes' } });
      expect(response.status).toBe(200); expect(await response.json()).toEqual(identity);
      expect((await fetch(`${base}${prefix}/identity`)).status).toBe(401);
      expect((await fetch(`${base}${prefix}-unrelated/identity`, { headers: { 'x-owner': 'yes' } })).status).toBe(404);
    }

    await provider.dispose(); await vi.waitFor(() => expect(first.size).toBe(0));
    expect((await fetch(`${base}${ZETA_API_PATH}/identity`, { headers: { 'x-owner': 'yes' } })).status).toBe(404);
    activeRoutes = new Map<string, Route>();
    const replacement = provideWeb(activeRoutes); await replacement.await();
    await vi.waitFor(() => expect(activeRoutes.size).toBe(2));
    expect(await (await fetch(`${base}${LEGACY_ZETA_API_PATH}/identity`, { headers: { 'x-owner': 'yes' } })).json()).toEqual(identity);
    await owner.dispose(); await vi.waitFor(() => expect(activeRoutes.size).toBe(0));
    expect((await fetch(`${base}${ZETA_API_PATH}/identity`, { headers: { 'x-owner': 'yes' } })).status).toBe(404);
  });
});
