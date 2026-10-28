import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { ownerRoutes } from './host-routes.ts';

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
});
