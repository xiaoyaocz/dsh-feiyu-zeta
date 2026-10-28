import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { BrowserService, DEFAULT_BROWSER_SETTINGS, type ExternalModuleHost, publicHttpUrl, serviceHash } from './browser.ts';
import { PersonaService } from './persona.ts';
import { DEFAULT_IMAGE_SETTINGS, ImageService } from './images.ts';
import { DEFAULT_DEPLOYMENT_SETTINGS, DeploymentService, solvePreviewChallenge } from './deployments.ts';
import type { ModuleExecution } from './contracts.ts';
import { PUBLIC_SPACE } from './state.ts';

const roots: string[] = [];
const disposables: Array<{ dispose(): Promise<void> }> = [];
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex');
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const cf = (result: unknown): Response => json({ success: true, result });
function exec(callId = 'call1', id = 'a', signal = new AbortController().signal): ModuleExecution { return { agent: { id }, callId, signal }; }
async function fixture(): Promise<{ host: ExternalModuleHost; send: ReturnType<typeof vi.fn> }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-zeta-external-')); roots.push(root);
  const send = vi.fn(async () => ({ messageId: 'qq-receipt' }));
  const host = { dataDir: root, ctx: { get: () => ({ register: vi.fn() }) },
    bindingFor: (agent: unknown) => {
      const id = (agent as { id?: string })?.id;
      return ['a', 'b'].includes(id ?? '') ? { key: `c2c:${id}`, appId: 'bot', scope: 'c2c', peerId: id, sessionId: id } : undefined;
    }, isLifeAgent: (agent: unknown) => (agent as { id?: string })?.id === 'life',
    sendFile: send, resolveServiceKey: vi.fn(async (provider: string) => `${provider}-secret`),
    requireWritable: vi.fn(),
  } as unknown as ExternalModuleHost;
  return { host, send };
}
afterEach(async () => {
  for (const item of disposables.splice(0)) await item.dispose();
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    const target = resolve(root);
    if (!basename(target).startsWith('dsh-zeta-external-') || relative(resolve(tmpdir()), target).startsWith('..')) throw new Error('Unsafe test cleanup');
    await rm(target, { recursive: true, force: true });
  }
});
function mockBrowser() {
  const page = { goto: vi.fn(async () => {}), url: () => 'https://example.com/', title: async () => 'Example', setDefaultTimeout: vi.fn(),
    locator: vi.fn(() => ({ innerText: vi.fn(async () => 'page text'), click: vi.fn(async () => {}), fill: vi.fn(async () => {}) })),
    screenshot: vi.fn(async ({ path }: { path: string }) => { await writeFile(path, png); }) };
  const context = { route: vi.fn(async () => {}), newPage: vi.fn(async () => page), close: vi.fn(async () => {}) };
  const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => {}) };
  return { page, context, browser: browser as unknown as Browser };
}
describe('Cloudflare browser lifecycle', () => {
  it('uses Playwright CDP and explicitly deletes the remote session after a task', async () => {
    const { host } = await fixture(); const mock = mockBrowser();
    const request = vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST' ? json({ sessionId: 'remote1' }) : json({ status: 'closing' }));
    const connect = vi.fn(async () => mock.browser);
    const service = new BrowserService(host, () => ({ ...DEFAULT_BROWSER_SETTINGS, enabled: true, accountId: 'a'.repeat(32) }), { fetch: request, connect }); disposables.push(service);
    const result = await service.run({ actions: [{ action: 'goto', url: 'https://example.com/' }, { action: 'read' }] }, exec());
    expect(result.closed).toBe(true); expect(result).toMatchObject({ results: [{ action: 'goto' }, { action: 'read', text: 'page text' }] });
    expect(connect).toHaveBeenCalledWith(expect.stringContaining('/browser-run/devtools/browser/remote1'), { Authorization: 'Bearer cloudflare-secret' });
    expect(request.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
    expect(mock.context.close).toHaveBeenCalledOnce(); expect(mock.browser.close).toHaveBeenCalledOnce();
    expect((await service.status()).active).toBe(0);
  });
  it('cleans up remote resources after an action fails', async () => {
    const { host } = await fixture(); const mock = mockBrowser(); mock.page.goto.mockRejectedValue(new Error('raw transport details'));
    const request = vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST' ? json({ sessionId: 'remote1' }) : json({ status: 'closing' }));
    const service = new BrowserService(host, () => ({ ...DEFAULT_BROWSER_SETTINGS, enabled: true, accountId: 'a'.repeat(32) }), { fetch: request, connect: async () => mock.browser }); disposables.push(service);
    await expect(service.run({ actions: [{ action: 'goto', url: 'https://example.com' }] }, exec())).rejects.toMatchObject({ code: 'BROWSER_ACTION' });
    expect(request.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
  });
  it('isolates retained sessions by trusted conversation and supports quiesce then reuse', async () => {
    const { host } = await fixture(); const mock = mockBrowser(); let remote = 0;
    const request = vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST' ? json({ sessionId: `remote${++remote}` }) : json({ status: 'closing' }));
    const service = new BrowserService(host, () => ({ ...DEFAULT_BROWSER_SETTINGS, enabled: true, accountId: 'a'.repeat(32) }), { fetch: request, connect: async () => mock.browser }); disposables.push(service);
    const first = await service.run({ actions: [{ action: 'read' }], keepSession: true }, exec());
    await expect(service.run({ session: first.session as string, actions: [{ action: 'read' }] }, exec('b', 'b'))).rejects.toMatchObject({ code: 'NO_SESSION' });
    await service.quiesce(); expect((await service.status()).active).toBe(0);
    await service.run({ actions: [{ action: 'read' }] }, exec('next')); expect(remote).toBe(2);
  });
  it('deletes acquired sessions even when Playwright cannot connect and records no secrets', async () => {
    const { host } = await fixture();
    const request = vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST' ? json({ sessionId: 'remote1' }) : json({ status: 'closing' }));
    const service = new BrowserService(host, () => ({ ...DEFAULT_BROWSER_SETTINGS, enabled: true, accountId: 'a'.repeat(32) }), { fetch: request, connect: async () => { throw new Error('bad connection'); } }); disposables.push(service);
    await expect(service.run({ actions: [{ action: 'read' }] }, exec())).rejects.toMatchObject({ code: 'BROWSER_CONNECT' });
    expect(request.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
    expect(await readFile(join(host.dataDir, 'browser', 'usage.json'), 'utf8')).not.toContain('secret');
  });
  it('blocks invalid/private destinations and cancelled work before acquiring', async () => {
    const { host } = await fixture(); const request = vi.fn<typeof fetch>();
    const service = new BrowserService(host, () => ({ ...DEFAULT_BROWSER_SETTINGS, enabled: true, accountId: 'a'.repeat(32) }), { fetch: request }); disposables.push(service);
    for (const url of ['http://127.0.0.1/', 'file:///secret', 'http://10.0.0.1', 'https://user:secret@example.com']) expect(() => publicHttpUrl(url)).toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(service.run({ actions: [{ action: 'read' }] }, exec('x', 'a', controller.signal))).rejects.toMatchObject({ code: 'ABORTED' });
    expect(request).not.toHaveBeenCalled();
  });
  it('enforces concurrency and persisted cost reservations', async () => {
    const { host } = await fixture(); const mock = mockBrowser();
    const request = vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST' ? json({ sessionId: 'remote1' }) : json({ status: 'closing' }));
    const service = new BrowserService(host, () => ({ ...DEFAULT_BROWSER_SETTINGS, enabled: true, accountId: 'a'.repeat(32), maxSessionMs: 1000, dailyBudgetMs: 1000 }), { fetch: request, connect: async () => mock.browser }); disposables.push(service);
    await service.run({ actions: [{ action: 'read' }], keepSession: true }, exec());
    await expect(service.run({ actions: [{ action: 'read' }] }, exec('other', 'b'))).rejects.toMatchObject({ code: 'CONCURRENCY' });
    expect((await service.status()).usedMsToday).toBe(1000);
  });
  it('reports failed remote cleanup honestly and retries its orphan journal', async () => {
    const { host } = await fixture(); const mock = mockBrowser(); let failDelete = true;
    const request = vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST' ? json({ sessionId: 'orphan' }) :
      failDelete ? json({ error: 'not released' }, 503) : json({ status: 'closing' }));
    const service = new BrowserService(host, () => ({ ...DEFAULT_BROWSER_SETTINGS, enabled: true, accountId: 'a'.repeat(32) }), { fetch: request, connect: async () => mock.browser }); disposables.push(service);
    const result = await service.run({ actions: [{ action: 'read' }] }, exec());
    expect(result).toMatchObject({ closed: false, cleanupPending: true }); expect((await service.status()).cleanupPending).toBe(1);
    failDelete = false; await service.recover(); expect((await service.status()).cleanupPending).toBe(0);
  });
  it('ends a retained browser at its hard deadline without another model instruction', async () => {
    const { host } = await fixture(); const mock = mockBrowser();
    const request = vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST' ? json({ sessionId: 'hard-deadline' }) : json({ status: 'closing' }));
    const service = new BrowserService(host, () => ({ ...DEFAULT_BROWSER_SETTINGS, enabled: true, accountId: 'a'.repeat(32), maxSessionMs: 1000 }), { fetch: request, connect: async () => mock.browser }); disposables.push(service);
    await service.run({ actions: [{ action: 'read' }], keepSession: true }, exec());
    await new Promise(resolve => setTimeout(resolve, 1150));
    expect(request.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
    expect((await service.status()).active).toBe(0);
  });
  it('aborts an in-flight operation and releases the remote browser immediately', async () => {
    const { host } = await fixture(); const mock = mockBrowser(); const controller = new AbortController();
    let begin!: () => void; let rejectNavigation!: (error: Error) => void;
    const began = new Promise<void>(resolve => { begin = resolve; });
    mock.page.goto.mockImplementation(async () => { begin(); return new Promise<void>((_resolve, reject) => { rejectNavigation = reject; }); });
    mock.context.close.mockImplementation(async () => { rejectNavigation(new Error('closed')); });
    const request = vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST' ? json({ sessionId: 'cancelled' }) : json({ status: 'closing' }));
    const service = new BrowserService(host, () => ({ ...DEFAULT_BROWSER_SETTINGS, enabled: true, accountId: 'a'.repeat(32) }), { fetch: request, connect: async () => mock.browser }); disposables.push(service);
    const task = service.run({ actions: [{ action: 'goto', url: 'https://example.com' }] }, exec('cancel', 'a', controller.signal));
    await began; controller.abort(); await expect(task).rejects.toMatchObject({ code: 'ABORTED' });
    expect(request.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1); expect((await service.status()).active).toBe(0);
  });
});
describe('persona and ApiMart image jobs', () => {
  it('stores the persona globally, supplies actual base64 bytes and updates synchronous context', async () => {
    const { host } = await fixture(); const persona = new PersonaService(host);
    const result = await persona.upload({ bytes: png, fileName: '../../unsafe.png', description: '红色头发' });
    expect(result.fileName).not.toContain('unsafe'); expect(persona.contextText()).toContain('红色头发');
    expect(await persona.referenceDataUrl()).toBe(`data:image/png;base64,${png.toString('base64')}`);
    await persona.setDescription('蓝色眼睛'); expect(persona.contextText()).toContain('蓝色眼睛');
    const restored = new PersonaService(host); await restored.get(); expect(restored.contextText()).toContain('蓝色眼睛');
    await persona.remove(); expect(persona.contextText()).toBe(''); expect(await persona.get()).toBeUndefined();
  });
  it('submits ext/1K/n1 with no fallback, automatically references persona, persists task and sends once', async () => {
    const { host, send } = await fixture(); const persona = new PersonaService(host); await persona.upload({ bytes: png });
    const request = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === 'POST') return json({ code: 200, data: [{ status: 'submitted', task_id: 'task1' }] });
      if (String(url).includes('/v1/tasks/')) return json({ code: 200, data: { id: 'task1', status: 'completed', cost: 0.1, result: { images: [{ url: ['https://images.example.com/result.png'] }] } } });
      expect(init?.headers).toBeUndefined(); return new Response(png);
    });
    const service = new ImageService(host, () => ({ ...DEFAULT_IMAGE_SETTINGS, enabled: true }), persona, { fetch: request }); disposables.push(service);
    const input = { prompt: '画一幅自画像', send: true };
    const first = await service.generate(input, exec()); const again = await service.generate(input, exec());
    expect(first).toEqual(again); expect(first).toMatchObject({ status: 'completed', delivery: 'sent', selfPortrait: true, cost: 0.1 });
    const body = JSON.parse(request.mock.calls[0]![1]!.body as string);
    expect(body).toMatchObject({ model: 'gemini-nano-banana-2.1-ext', resolution: '1K', n: 1, official_fallback: false, image_urls: [`data:image/png;base64,${png.toString('base64')}`] });
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1); expect(send).toHaveBeenCalledOnce();
    expect(await readFile(first.filePath!)).toEqual(png);
  });
  it('resumes a persisted pending task by GET after restart without a second paid submission', async () => {
    const { host } = await fixture(); const persona = new PersonaService(host); let status = 'pending';
    const request = vi.fn<typeof fetch>(async (url, init) => init?.method === 'POST' ? json({ code: 200, data: [{ task_id: 'task1' }] }) :
      String(url).includes('/v1/tasks/') ? json({ code: 200, data: { id: 'task1', status, ...(status === 'completed' ? { result: { images: [{ url: ['https://images.example.com/image.png'] }] } } : {}) } }) : new Response(png));
    const settings = () => ({ ...DEFAULT_IMAGE_SETTINGS, enabled: true });
    const first = new ImageService(host, settings, persona, { fetch: request }); disposables.push(first);
    const pending = await first.generate({ prompt: 'a cat', wait: false }, exec()); expect(pending.status).toBe('pending');
    const restarted = new ImageService(host, settings, persona, { fetch: request }); disposables.push(restarted); status = 'completed';
    expect((await restarted.status(pending.id, exec())).status).toBe('completed');
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect((await restarted.status(pending.id, exec('b', 'b'))).id).toBe(pending.id);
  });
  it('never resubmits an unknown charge and refuses self portraits without a persona', async () => {
    const { host } = await fixture(); const persona = new PersonaService(host);
    const request = vi.fn<typeof fetch>(async () => { throw new Error('raw apimart-secret'); });
    const service = new ImageService(host, () => ({ ...DEFAULT_IMAGE_SETTINGS, enabled: true }), persona, { fetch: request }); disposables.push(service);
    await expect(service.generate({ prompt: 'self portrait' }, exec('self'))).rejects.toMatchObject({ code: 'NO_PERSONA' });
    await expect(service.generate({ prompt: 'cat' }, exec())).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect((await service.generate({ prompt: 'cat' }, exec())).status).toBe('unknown'); expect(request).toHaveBeenCalledOnce();
  });
  it('preserves an unknown QQ send without regeneration or duplicate sending', async () => {
    const { host, send } = await fixture(); send.mockRejectedValue(new Error('platform result unknown'));
    const request = vi.fn<typeof fetch>(async (url, init) => init?.method === 'POST' ? json({ code: 200, data: [{ task_id: 'task1' }] }) : String(url).includes('/v1/tasks/') ?
      json({ code: 200, data: { id: 'task1', status: 'completed', result: { images: [{ url: ['https://images.example.com/image.png'] }] } } }) : new Response(png));
    const service = new ImageService(host, () => ({ ...DEFAULT_IMAGE_SETTINGS, enabled: true }), new PersonaService(host), { fetch: request }); disposables.push(service);
    const first = await service.generate({ prompt: 'cat', send: true }, exec()); expect(first.delivery).toBe('unknown');
    expect((await service.status(first.id, exec())).delivery).toBe('unknown'); expect(send).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledTimes(3);
  });
  it('enforces the daily paid-submission budget conservatively', async () => {
    const { host } = await fixture();
    const request = vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST' ? json({ code: 200, data: [{ task_id: 'task1' }] }) : json({ code: 200, data: { id: 'task1', status: 'pending' } }));
    const service = new ImageService(host, () => ({ ...DEFAULT_IMAGE_SETTINGS, enabled: true, dailyLimit: 1 }), new PersonaService(host), { fetch: request }); disposables.push(service);
    await service.generate({ prompt: 'cat', wait: false }, exec());
    await expect(service.generate({ prompt: 'dog', wait: false }, exec('next'))).rejects.toMatchObject({ code: 'BUDGET' });
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('rebuilds generated file paths from the new data root after migration', async () => {
    const { host } = await fixture(); const id = serviceHash('call1').slice(0, 40); const owner = PUBLIC_SPACE;
    const directory = join(host.dataDir, 'images', serviceHash(owner).slice(0, 32));
    const { mkdir } = await import('node:fs/promises'); await mkdir(directory, { recursive: true }); await writeFile(join(directory, `${id}.png`), png);
    await writeFile(join(directory, `${id}.json`), JSON.stringify({ version: 1, id, owner, status: 'completed', fingerprint: 'x', mimeType: 'image/png', sha256: serviceHash(png), filePath: 'Z:\\old-machine\\image.png', delivery: 'sent' }));
    const service = new ImageService(host, () => ({ ...DEFAULT_IMAGE_SETTINGS, enabled: true }), new PersonaService(host), { fetch: vi.fn() }); disposables.push(service);
    expect((await service.list(exec().agent))[0]?.filePath).toBe(join(directory, `${id}.png`));
    expect((await service.status(id, exec())).filePath).toBe(join(directory, `${id}.png`));
  });
  it('coalesces simultaneous recovery queries so completion sends to QQ only once', async () => {
    const { host, send } = await fixture(); let ready = false;
    const request = vi.fn<typeof fetch>(async (url, init) => init?.method === 'POST' ? json({ code: 200, data: [{ task_id: 'task1' }] }) : String(url).includes('/v1/tasks/') ?
      json({ code: 200, data: { id: 'task1', status: ready ? 'completed' : 'pending', ...(ready ? { result: { images: [{ url: ['https://images.example.com/image.png'] }] } } : {}) } }) : new Response(png));
    const service = new ImageService(host, () => ({ ...DEFAULT_IMAGE_SETTINGS, enabled: true }), new PersonaService(host), { fetch: request }); disposables.push(service);
    const pending = await service.generate({ prompt: 'cat', send: true, wait: false }, exec()); ready = true;
    await Promise.all([service.status(pending.id, exec()), service.status(pending.id, exec())]);
    expect(send).toHaveBeenCalledOnce(); expect(request.mock.calls.filter(([url]) => String(url).includes('/v1/tasks/'))).toHaveLength(2);
  });
  it('quiesces an active submission without losing its journal and remains usable afterwards', async () => {
    const { host } = await fixture(); let begin!: () => void;
    const began = new Promise<void>(resolve => { begin = resolve; }); let first = true;
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method !== 'POST') return json({ code: 200, data: { id: 'next-task', status: 'pending' } });
      if (!first) return json({ code: 200, data: [{ task_id: 'next-task' }] });
      first = false; begin();
      return new Promise<Response>((_resolve, reject) => { init.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); });
    });
    const service = new ImageService(host, () => ({ ...DEFAULT_IMAGE_SETTINGS, enabled: true }), new PersonaService(host), { fetch: request }); disposables.push(service);
    const task = service.generate({ prompt: 'cat' }, exec());
    const rejection = expect(task).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    await began; await service.quiesce(); await rejection;
    expect((await service.list(exec().agent))[0]?.status).toBe('unknown');
    expect((await service.generate({ prompt: 'dog', wait: false }, exec('next'))).status).toBe('pending');
  });
});
describe('Cloudflare temporary static deployments', () => {
  function secrets() { const map = new Map<string, string>(); return { map, set: async (id: string, value: string) => { map.set(id, value); }, get: async (id: string) => map.get(id), delete: async (id: string) => { map.delete(id); } }; }
  function provider() {
    let sessions = 0;
    return { get sessions() { return sessions; }, fetch: vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url);
      if (path.endsWith('/previews/challenge')) return cf({ challengeToken: 'challenge', seed: Buffer.alloc(32).toString('base64url'), k: 1, g: 1 });
      if (path.endsWith('/provisioning/previews')) { sessions++; return cf({ account: { id: 'b'.repeat(32), apiToken: 'temporary-secret', expiresAt: new Date(Date.now() + 3600000).toISOString() }, claim: { url: 'https://dash.cloudflare.com/claim-preview?claimToken=ownership-secret', expiresAt: new Date(Date.now() + 3600000).toISOString() } }); }
      if (path.endsWith('/assets-upload-session')) {
        const manifest = JSON.parse(init?.body as string).manifest as Record<string, { hash: string }>;
        return cf({ jwt: 'upload-token', buckets: [Object.values(manifest).map(file => file.hash)] });
      }
      if (path.includes('/assets/upload?')) { expect(init?.headers).toMatchObject({ authorization: 'Bearer upload-token' }); expect(init?.body).toBeInstanceOf(FormData); return cf({ jwt: 'completion-token' }); }
      if (path.endsWith('/subdomain')) return cf(path.includes('/scripts/') ? { enabled: true } : { subdomain: 'preview' });
      if (path.includes('workers.dev')) return new Response('<h1>hello</h1>');
      if (init?.method === 'PUT') {
        const form = init.body as FormData; const metadata = form.get('metadata') as Blob;
        expect(JSON.parse(await metadata.text())).toMatchObject({ assets: { jwt: 'completion-token' }, bindings: [{ type: 'assets', name: 'ASSETS' }] });
        return cf({ id: 'worker' });
      }
      if (init?.method === 'DELETE') return cf({});
      throw new Error(`Unexpected mock request: ${path}`);
    }) };
  }
  const input = { title: 'Test', files: [{ path: 'index.html', content: '<h1>hello</h1>' }, { path: 'app.js', content: 'console.log("hello")' }] };
  it('solves the exact bounded checkpoint challenge off the event loop and supports cancellation', async () => {
    const seed = Buffer.alloc(32); const signal = new AbortController().signal;
    const result = await solvePreviewChallenge({ challengeToken: 't', seed: seed.toString('base64url'), k: 2, g: 2 }, signal);
    let hash = serviceHash(seed); const checkpoints = [Buffer.from(hash, 'hex')];
    for (let segment = 0; segment < 2; segment++) { for (let i = 0; i < 2; i++) hash = serviceHash(Buffer.from(hash, 'hex')); checkpoints.push(Buffer.from(hash, 'hex')); }
    expect(result.solution.checkpoints).toBe(Buffer.concat(checkpoints).toString('base64'));
    await expect(solvePreviewChallenge({ challengeToken: 't', seed: seed.toString('base64url'), k: 8000, g: 999999 }, signal)).rejects.toMatchObject({ code: 'INVALID_CHALLENGE' });
  });
  it('uses the supported assets protocol and returns no claim/token to the model or metadata files', async () => {
    const { host } = await fixture(); const store = secrets(); const mock = provider();
    const service = new DeploymentService(host, () => ({ ...DEFAULT_DEPLOYMENT_SETTINGS, enabled: true, acceptedTerms: true }), { secrets: store, fetch: mock.fetch }); disposables.push(service);
    const result = await service.deploy(input, exec());
    expect(result).toMatchObject({ status: 'ready', fileCount: 2, previewUrl: expect.stringContaining('.preview.workers.dev/') });
    expect(JSON.stringify(result)).not.toContain('secret');
    const manifest = await readFile(join(host.dataDir, 'deployments', `${result.id}.json`), 'utf8'); expect(manifest).not.toContain('secret');
    expect((await service.claim(result.id)).claimUrl).toContain('ownership-secret');
    expect((await service.status(result.id, exec())).status).toBe('ready');
    expect((await service.list(exec().agent))).toHaveLength(1);
    expect((await service.list(exec('b', 'b').agent))).toHaveLength(1);
  });
  it('reuses the same account for iterations and does not create twice on replay', async () => {
    const { host } = await fixture(); const store = secrets(); const mock = provider();
    const service = new DeploymentService(host, () => ({ ...DEFAULT_DEPLOYMENT_SETTINGS, enabled: true, acceptedTerms: true }), { secrets: store, fetch: mock.fetch }); disposables.push(service);
    const first = await service.deploy(input, exec()); expect((await service.deploy(input, exec())).id).toBe(first.id);
    await service.deploy({ ...input, id: first.id, files: [{ path: 'index.html', content: 'changed' }] }, exec('update'));
    expect(mock.sessions).toBe(1);
    expect((await service.status(first.id, exec('b', 'b'))).id).toBe(first.id);
    expect((await service.remove(first.id, exec())).status).toBe('deleted'); expect(store.map.has(first.id)).toBe(false);
  });
  it('requires accepted terms and blocks paths/config files before any account provisioning', async () => {
    const { host } = await fixture(); const request = vi.fn<typeof fetch>();
    const disabled = new DeploymentService(host, () => ({ ...DEFAULT_DEPLOYMENT_SETTINGS, enabled: true }), { secrets: secrets(), fetch: request }); disposables.push(disabled);
    await expect(disabled.deploy(input, exec())).rejects.toMatchObject({ code: 'TERMS_REQUIRED' });
    const service = new DeploymentService(host, () => ({ ...DEFAULT_DEPLOYMENT_SETTINGS, enabled: true, acceptedTerms: true }), { secrets: secrets(), fetch: request }); disposables.push(service);
    for (const path of ['../index.html', '.env', '/index.html', 'C:/index.html', 'package.json', 'secret.json']) {
      await expect(service.deploy({ files: [{ path, content: 'secret' }] }, exec())).rejects.toMatchObject({ code: 'INVALID_FILE' });
    }
    expect(request).not.toHaveBeenCalled();
  });
  it('expires local temporary control and deletes credentials without leaking the claim link', async () => {
    const { host } = await fixture(); const store = secrets(); const mock = provider();
    const service = new DeploymentService(host, () => ({ ...DEFAULT_DEPLOYMENT_SETTINGS, enabled: true, acceptedTerms: true }), { secrets: store, fetch: mock.fetch }); disposables.push(service);
    const result = await service.deploy(input, exec());
    const path = join(host.dataDir, 'deployments', `${result.id}.json`); const saved = JSON.parse(await readFile(path, 'utf8')); saved.expiresAt = new Date(Date.now() - 1000).toISOString(); await writeFile(path, JSON.stringify(saved));
    expect((await service.status(result.id, exec())).status).toBe('expired'); expect(store.map.has(result.id)).toBe(false);
    await expect(service.claim(result.id)).rejects.toMatchObject({ code: 'EXPIRED' });
    expect((await readdir(join(host.dataDir, 'websites', result.id))).length).toBe(1);
  });
  it('defers expiry writes while backup maintenance is active and cleans up afterwards', async () => {
    const { host } = await fixture(); const store = secrets(); const mock = provider();
    const service = new DeploymentService(host, () => ({ ...DEFAULT_DEPLOYMENT_SETTINGS, enabled: true, acceptedTerms: true }), { secrets: store, fetch: mock.fetch }); disposables.push(service);
    const result = await service.deploy(input, exec());
    const path = join(host.dataDir, 'deployments', `${result.id}.json`); const saved = JSON.parse(await readFile(path, 'utf8')); saved.expiresAt = new Date(Date.now() - 1000).toISOString(); await writeFile(path, JSON.stringify(saved));
    const original = await readFile(path, 'utf8');
    vi.mocked(host.requireWritable!).mockImplementation(() => { throw new Error('maintenance'); });
    expect((await service.list(exec().agent))[0]?.status).toBe('expired');
    await service.quiesce(); expect(await readFile(path, 'utf8')).toBe(original); expect(store.map.has(result.id)).toBe(true);
    vi.mocked(host.requireWritable!).mockImplementation(() => {});
    await service.recover(); expect(store.map.has(result.id)).toBe(false);
  });
});
