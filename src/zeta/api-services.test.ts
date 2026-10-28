import type { Context } from '@deepseek-ai/cordis';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZetaState, spaceDirectory } from './state.ts';
import { testDomainContext } from './test-support.ts';
import { ZetaRuntime } from './runtime.ts';
import { PersonaService } from './persona.ts';
import { registerZetaApi } from './api.ts';
import type { ZetaServices } from './services.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zeta-api-services-'));
  cleanup.push(async () => { const rel = relative(tmpdir(), root); if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Unsafe fixture cleanup'); await rm(root, { recursive: true, force: true }); });
  let route!: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  const credentials = new Map<string, string>();
  const ctx = Object.assign(testDomainContext(), {
    connection: { admit: (req: IncomingMessage) => req.headers['x-owner'] === 'yes' ? { peer: { principal: { kind: 'owner' } } } : req.headers['x-owner'] === 'no' ? { peer: { principal: { kind: 'remote' } } } : { rejection: 401 } },
    get: () => ({ register: (value: { handler: typeof route }) => { route = value.handler; return () => {}; } }),
    effect: () => {}, credentials: { set: async (ref: unknown, value: string) => { credentials.set(JSON.stringify(ref), value); }, unset: async (ref: unknown) => { credentials.delete(JSON.stringify(ref)); }, describe: async (ref: unknown) => ({ configured: credentials.has(JSON.stringify(ref)) }) },
  }) as unknown as Context;
  const state = await ZetaState.open(ctx); cleanup.push(() => state.close());
  const runtime = new ZetaRuntime(ctx, state, 'bot', root);
  const persona = new PersonaService(runtime); const actor = runtime.managementAgent(runtime.selfSpace);
  const imageRoot = join(root, 'images', spaceDirectory(runtime.spaceFor(actor))); await mkdir(imageRoot, { recursive: true });
  const id = 'b'.repeat(40); const imagePath = join(imageRoot, `${id}.png`); await writeFile(imagePath, Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex'));
  const image = { id, status: 'completed', model: 'gemini-nano-banana-2.1-ext', resolution: '1K', selfPortrait: false, createdAt: new Date().toISOString(), delivery: 'not_requested', filePath: imagePath, mimeType: 'image/png', bytes: 24 };
  const browser = { status: vi.fn(async () => ({ active: 0, usedMsToday: 123, cleanupPending: 0 })), quiesce: vi.fn(async () => {}), recover: vi.fn(async () => {}) };
  const images = { list: vi.fn(async (agent: unknown) => runtime.spaceFor(agent) === runtime.selfSpace ? [image] : []), generate: vi.fn(async () => image), status: vi.fn(async () => image) };
  const deployments = { list: vi.fn(async () => []), remove: vi.fn(async () => ({ status: 'deleted' })), claim: vi.fn(async () => ({ claimUrl: 'https://dash.cloudflare.com/claim-preview?claimToken=fixture-secret', expiresAt: new Date().toISOString() })) };
  const services = { persona, browser, images, deployments } as unknown as ZetaServices;
  const memes = { list: vi.fn(async (agent: unknown) => ({ items: [], actor: runtime.spaceFor(agent) })) };
  registerZetaApi(ctx, runtime, state, memes as never, { reconcile: async () => {}, runNow: async () => {}, stop: async () => {}, status: () => ({ status: 'disabled' }) }, undefined, services);
  const server = createServer((req, res) => { void route(req, res); }); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/zeta/api`;
  const call = (path: string, method = 'GET', body?: unknown, owner = 'yes', extraHeaders: Record<string, string> = {}) => fetch(`${base}${path}`, { method, headers: { 'x-owner': owner, 'content-type': 'application/json', ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { call, runtime, state, services, browser, images, deployments, credentials, image, memes };
}

describe('external-service management routes', () => {
  it('rejects untrusted callers before they can change settings, close browsers or reveal claim credentials', async () => {
    const { call, browser, deployments, state } = await fixture();
    expect((await call('/browser/close', 'POST', {}, '')).status).toBe(401);
    expect((await call('/deployments/claim?id=page', 'GET', undefined, 'no')).status).toBe(403);
    expect((await call('/settings', 'PUT', { ...state.settings, security: { administrators: ['attacker'] } }, 'no')).status).toBe(403);
    expect(browser.quiesce).not.toHaveBeenCalled(); expect(deployments.claim).not.toHaveBeenCalled(); expect(state.settings.security.administrators).toEqual([]);
  });
  it('stores new service credentials without returning their values in state', async () => {
    const { call, credentials } = await fixture(); const secret = 'private-apimart-fixture-token';
    expect((await call('/credential', 'PUT', { provider: 'apimart', value: secret })).status).toBe(200);
    expect([...credentials.values()]).toContain(secret);
    const response = await call('/state'); const text = await response.text(); expect(text).not.toContain(secret); expect(JSON.parse(text).credentials.apimart).toBe(true);
  });
  it('keeps image previews private, scopes gallery reads, and never sends a management-page generation to QQ', async () => {
    const { call, images, state, image } = await fixture();
    const list = await (await call('/images')).json(); expect(list.items[0].filePath).toBeUndefined();
    const response = await call(`/images/media?id=${image.id}`); expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('image/png');
    await state.bind({ appId: 'bot', scope: 'c2c', peerId: 'a', key: 'qq:bot:c2c:a', sessionId: 'a' });
    expect((await call(`/images/media?id=${image.id}&space=${encodeURIComponent('qq:bot:c2c:a')}`)).status).toBe(400);
    expect((await call('/images', 'POST', { prompt: '星空', send: true, target: 'group:secret' })).status).toBe(200);
    expect(images.generate.mock.calls[0]?.[0]).toMatchObject({ prompt: '星空', send: false });
  });
  it('saves a verified persona image and provides the same shared library regardless of selected memory space', async () => {
    const { call, services } = await fixture();
    const png = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
    const uploaded = await (await call('/persona', 'POST', { fileName: 'self.png', base64: png.toString('base64'), description: '蓝色的小鱼' })).json();
    expect(uploaded.reference.description).toBe('蓝色的小鱼'); expect(uploaded.reference.filePath).toBeUndefined();
    expect(services.persona.contextText()).toContain('蓝色的小鱼');
    const image = await call(`/persona/image?id=${uploaded.reference.id}`); expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
    expect((await (await call('/memes?space=unknown-legacy-space')).json()).actor).toBe('self:zeta');
  });
  it('reports unresolved remote cleanup instead of claiming the browser has closed', async () => {
    const { call, browser } = await fixture(); browser.status.mockResolvedValue({ active: 0, usedMsToday: 123, cleanupPending: 1 });
    expect(await (await call('/browser/close', 'POST', {})).json()).toMatchObject({ closed: false, browser: { cleanupPending: 1 } });
  });
  it('prevents an old settings page from overwriting the AI identity and resets only identity explicitly', async () => {
    const { call, state } = await fixture(); const stale = state.settings; const revision = state.identity.revision;
    await state.updateIdentity({ expected_revision: revision, reason: '自主选择新的称呼', name: '泽泽', habits: ['更喜欢先听再说'] });
    const oldClient = await call('/settings', 'PUT', { ...stale, group: { waitMs: 1234, maxWaitMs: 6000 } });
    expect(oldClient.status).toBe(200); expect(state.settings.name).toBe('泽泽'); expect(state.settings.group.waitMs).toBe(1234);
    const conflict = await call('/settings', 'PUT', { ...stale, group: { waitMs: 9999, maxWaitMs: 10000 } }, 'yes', { 'x-zeta-identity-revision': String(revision) });
    expect(conflict.status).toBe(400); expect(state.settings.group.waitMs).toBe(1234);
    const current = await (await call('/identity')).json(); expect(current.history.at(-1).reason).toBe('自主选择新的称呼');
    expect((await call('/identity/reset', 'POST', { expected_revision: current.revision }, 'no')).status).toBe(403);
    expect((await call('/identity/reset', 'POST', { expected_revision: revision })).status).toBe(400);
    expect((await call('/identity/reset', 'POST', { expected_revision: current.revision })).status).toBe(200);
    expect(state.settings.name).toBe('小鲸鱼'); expect(state.settings.group.waitMs).toBe(1234);
  });
  it('takes the state identity and revision together after asynchronous credential checks', async () => {
    const { call, state, runtime } = await fixture();
    vi.spyOn(runtime, 'credentialStatus').mockImplementationOnce(async () => {
      await state.updateIdentity({ expected_revision: state.identity.revision, reason: '读取状态期间的身份更新', name: '不会读到旧名字' });
      return { mimo: false, minimax: false, cloudflare: false, apimart: false };
    });
    const view = await (await call('/state')).json();
    expect(view.settings.name).toBe('不会读到旧名字'); expect(view.settings.name).toBe(view.identity.name); expect(view.identity.revision).toBe(state.identity.revision);
  });
});
