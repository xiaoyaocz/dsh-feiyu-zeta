import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { compatibleRoutePaths, ownerRoutes } from './host-routes.ts';
import { registerBindRoutes, type WebRoute } from '../setup/bind-routes.ts';
import { LEGACY_QQBOT_API_PATH, QQBOT_API_PATH } from './http-paths.ts';

describe('DSH owner admission for custom management routes', () => {
  for (const admission of [{ rejection: 401 }, { rejection: 403 }, { peer: { principal: { kind: 'session' } } }]) {
    it(`refuses unauthenticated or delegated callers: ${JSON.stringify(admission)}`, async () => {
      const ctx = { connection: { admit: vi.fn().mockReturnValue(admission) } } as unknown as Context;
      let invoke!: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
      const handler = vi.fn();
      const res = { writeHead: vi.fn(), end: vi.fn() };
      ownerRoutes(ctx, { register: route => { invoke = route.handler; return () => {}; } }).register({ kind: 'prefix', path: '/test', handler });
      await invoke({ headers: {} } as IncomingMessage, res as unknown as ServerResponse);
      expect(handler).not.toHaveBeenCalled();
      expect(res.writeHead).toHaveBeenCalledWith('rejection' in admission ? admission.rejection : 403, expect.any(Object));
    });
  }
  it('passes the original request only after the native Host admits its owner', async () => {
    const ctx = { connection: { admit: vi.fn().mockReturnValue({ peer: { principal: { kind: 'owner' } } }) } } as unknown as Context;
    let invoke!: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
    const handler = vi.fn(); const req = { headers: {} } as IncomingMessage; const res = {} as ServerResponse;
    const dispose = vi.fn();
    const stop = ownerRoutes(ctx, { register: route => { invoke = route.handler; return dispose; } }).register({ kind: 'exact', path: '/test', handler });
    await invoke(req, res);
    expect(ctx.connection.admit).toHaveBeenCalledWith(req);
    expect(handler).toHaveBeenCalledWith(req, res);
    stop(); expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps every binding/configuration alias authenticated and removes both sets on cleanup', async () => {
    let admission: unknown = { rejection: 401 };
    const ctx = { connection: { admit: () => admission } } as unknown as Context;
    const routes = new Map<string, WebRoute>();
    const server = { register: (route: WebRoute) => { routes.set(route.path, route); return () => { routes.delete(route.path); }; } };
    const configuration = { requireMention: true, appSecret: 'fixture-secret' };
    const stop = registerBindRoutes(ownerRoutes(ctx, server), null, { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, {
      boundAppId: () => 'fixture-bot', currentConfig: () => configuration,
    });
    expect(routes.size).toBe(10);
    for (const suffix of ['/bind', '/bind/refresh', '/bind/manual', '/bind/unbind', '/config']) {
      const [current, legacy] = compatibleRoutePaths(`${QQBOT_API_PATH}${suffix}`, QQBOT_API_PATH, LEGACY_QQBOT_API_PATH);
      expect(routes.has(current!)).toBe(true); expect(routes.has(legacy!)).toBe(true);
      for (const path of [current!, legacy!]) for (const value of [{ rejection: 401 }, { peer: { principal: { kind: 'session' } } }]) {
        admission = value;
        const response = { writeHead: vi.fn(), end: vi.fn() };
        await routes.get(path)!.handler({ headers: {}, method: 'GET' } as IncomingMessage, response as unknown as ServerResponse);
        expect(response.writeHead).toHaveBeenCalledWith('rejection' in value ? 401 : 403, expect.any(Object));
      }
    }
    admission = { peer: { principal: { kind: 'owner' } } };
    for (const prefix of [QQBOT_API_PATH, LEGACY_QQBOT_API_PATH]) for (const suffix of ['/bind', '/config']) {
      const response = { writeHead: vi.fn(), end: vi.fn() };
      await routes.get(`${prefix}${suffix}`)!.handler({ headers: { host: 'fixture.local' }, method: 'GET' } as IncomingMessage, response as unknown as ServerResponse);
      expect(response.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      const body = response.end.mock.calls.map(args => args[0] ?? '').join('');
      expect(JSON.parse(body)).toEqual(suffix === '/bind' ? { phase: 'bound', appId: 'fixture-bot' } : { config: { requireMention: true } });
      expect(body).not.toContain('fixture-secret');
      const crossOrigin = { writeHead: vi.fn(), end: vi.fn() };
      await routes.get(`${prefix}${suffix}`)!.handler({ headers: { host: 'fixture.local', origin: 'https://evil.example' }, method: 'GET' } as IncomingMessage, crossOrigin as unknown as ServerResponse);
      expect(crossOrigin.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    }
    stop(); expect(routes.size).toBe(0);
  });
});
