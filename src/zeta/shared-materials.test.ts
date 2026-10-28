import { afterEach, describe, expect, it, vi } from 'vitest';

const filesystemFault = vi.hoisted(() => ({
  unsupportedLink: false, linkAttempts: 0,
  publish: undefined as 'before' | 'after' | undefined,
  kind: undefined as 'asset' | 'deployment' | undefined,
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      if (filesystemFault.unsupportedLink) { filesystemFault.linkAttempts++; throw Object.assign(new Error('mock unsupported hard links'), { code: 'ENOTSUP' }); }
      return actual.link(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const destination = String(args[1]);
      const matches = filesystemFault.kind === 'asset' ? /\.(?:png|wav)$/u.test(destination) :
        filesystemFault.kind === 'deployment' && /[\\/]deployments[\\/][a-f0-9]{40}\.json$/u.test(destination);
      if (!filesystemFault.publish || !matches) return actual.rename(...args);
      const when = filesystemFault.publish; filesystemFault.publish = undefined;
      if (when === 'after') await actual.rename(...args);
      throw new Error(`mock interrupted ${filesystemFault.kind} publish ${when}`);
    },
  };
});
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { ModuleExecution, ModuleHost, SpeechSettings } from './contracts.ts';
import { PUBLIC_SPACE } from './state.ts';
import { migrateSharedMaterials, migratedOperationId, resolveSharedMaterialFile } from './shared-materials.ts';
import { DEFAULT_IMAGE_SETTINGS, ImageService } from './images.ts';
import { DEFAULT_DEPLOYMENT_SETTINGS, DeploymentService } from './deployments.ts';
import { BrowserService, DEFAULT_BROWSER_SETTINGS, scopeFor, serviceHash, type ExternalModuleHost } from './browser.ts';
import { PersonaService } from './persona.ts';
import { generateSpeech, listSpeechFiles } from './speech.ts';
import type { Browser } from 'playwright-core';

const roots: string[] = [], cleanup: Array<() => Promise<void>> = [];
const publicDir = serviceHash(PUBLIC_SPACE).slice(0, 32);
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex');
const wav = Buffer.from('524946462400000057415645666d74201000000001000100805d000000bb0000020010006461746100000000', 'hex');
const speechSettings: SpeechSettings = { enabled: true, provider: 'mimo', maxTextCharacters: 1000, timeoutMs: 10000,
  mimo: { model: 'mimo-v2.5-tts', voice: 'mimo_default', speed: 1 }, minimax: { model: 'speech-2.8-hd', voice: 'male-qn-qingse', speed: 1 } };
const exec = (actor = 'a', callId = 'old-call'): ModuleExecution => ({ agent: { id: actor }, callId, signal: new AbortController().signal });
const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-zeta-shared-')); roots.push(root);
  const send = vi.fn(async () => ({ messageId: 'receipt' }));
  const host = { dataDir: root, ctx: { get: () => ({ register: vi.fn() }) }, requireWritable: vi.fn(),
    bindingFor: (agent: unknown) => {
      const id = (agent as { id?: string })?.id;
      return id && ['a', 'b', 'owner'].includes(id) ? { key: id === 'owner' ? PUBLIC_SPACE : `qq:bot:c2c:${id}`, appId: 'bot', scope: 'c2c', peerId: id, sessionId: id } : undefined;
    }, isLifeAgent: (agent: unknown) => (agent as { id?: string })?.id === 'life',
    directoryFor: async (_agent: unknown, kind: string) => join(root, kind, kind === 'memes' ? 'shared' : publicDir),
    resolveApiKey: vi.fn(async () => 'fake-speech-key'), resolveServiceKey: vi.fn(async () => 'fake-service-key'), sendFile: send,
  } as unknown as ExternalModuleHost;
  return { root, host, send };
}
async function put(root: string, path: string, value: Buffer | Record<string, unknown>) {
  const target = join(root, ...path.split('/')); await mkdir(dirname(target), { recursive: true }); await writeFile(target, Buffer.isBuffer(value) ? value : JSON.stringify(value)); return target;
}
function imageRecord(owner: string, id: string, image?: Buffer, overrides: Record<string, unknown> = {}) {
  return { version: 1, owner, id, fingerprint: 'fingerprint', model: DEFAULT_IMAGE_SETTINGS.model, resolution: '1K', createdAt: '2026-10-29T00:00:00.000Z',
    selfPortrait: false, send: true, delivery: 'not_requested', status: image ? 'completed' : 'pending', taskId: `task_${owner.slice(-1)}`,
    ...(image ? { mimeType: 'image/png', bytes: image.length, sha256: serviceHash(image), filePath: 'Z:\\stale-computer\\must-not-be-read.png' } : {}), ...overrides };
}
async function seedImage(root: string, owner: string, id: string, image?: Buffer, overrides: Record<string, unknown> = {}) {
  const base = `images/${serviceHash(owner).slice(0, 32)}/${id}`;
  await put(root, `${base}.json`, imageRecord(owner, id, image, overrides)); if (image) await put(root, `${base}.png`, image); return base;
}
afterEach(async () => {
  filesystemFault.unsupportedLink = false; filesystemFault.linkAttempts = 0; filesystemFault.publish = undefined; filesystemFault.kind = undefined;
  for (const dispose of cleanup.splice(0)) await dispose();
  for (const root of roots.splice(0)) {
    const checked = resolve(root);
    if (!basename(checked).startsWith('dsh-zeta-shared-') || relative(resolve(tmpdir()), checked).startsWith('..')) throw new Error('Unexpected cleanup target');
    await rm(checked, { recursive: true, force: true });
  }
});
describe('one public material namespace with durable legacy receipts', () => {
  it('imports both conflicting image jobs without losing bytes, task IDs or delivery states', async () => {
    const { root, host } = await setup(); const id = 'a'.repeat(40), a = 'qq:bot:c2c:a', b = 'qq:bot:c2c:b';
    const second = Buffer.concat([png, Buffer.from('second-original')]);
    const aBase = await seedImage(root, a, id, png, { delivery: 'sent' });
    const bBase = await seedImage(root, b, id, second, { delivery: 'unknown' });
    const report = await migrateSharedMaterials(root); expect(report.images).toBe(2); expect(report.conflicts).toBe(1);
    const ai = await migratedOperationId(root, 'images', a, id), bi = await migratedOperationId(root, 'images', b, id); expect(ai).not.toBe(bi);
    const service = new ImageService(host, () => ({ ...DEFAULT_IMAGE_SETTINGS, enabled: true }), new PersonaService(host), { fetch: vi.fn() }); cleanup.push(() => service.dispose());
    const list = await service.list(exec('a').agent); expect(await service.list(exec('b').agent)).toEqual(list); expect(list).toHaveLength(2);
    expect((await service.status(id, exec('a'))).taskId).toBe('task_a');
    expect((await service.status(id, exec('b'))).taskId).toBe('task_b');
    const canonical = list.find(item => item.id === id)!;
    expect((await service.status(id, exec('owner'))).taskId).toBe(canonical.taskId);
    expect((await service.status(`public:${id}`, exec('b'))).taskId).toBe(canonical.taskId);
    for (const [mapped, original, delivery] of [[ai, png, 'sent'], [bi, second, 'unknown']] as const) {
      const record = JSON.parse(await readFile(join(root, 'images', publicDir, `${mapped}.json`), 'utf8'));
      expect(record).toMatchObject({ owner: PUBLIC_SPACE, id: mapped, send: false, delivery });
      expect(await readFile(record.filePath)).toEqual(original);
    }
    expect(await readFile(join(root, `${aBase}.png`))).toEqual(png); expect(await readFile(join(root, `${bBase}.png`))).toEqual(second);
  });
  it('keeps migrated pending jobs queryable and a replay never creates a second paid job or QQ delivery', async () => {
    const { root, host, send } = await setup(); const owner = 'qq:bot:c2c:a', id = serviceHash('old-call').slice(0, 40);
    const fingerprint = serviceHash(JSON.stringify({ prompt: 'cat', send: true, selfPortrait: false, model: DEFAULT_IMAGE_SETTINGS.model, resolution: '1K' }));
    await seedImage(root, owner, id, undefined, { fingerprint, taskId: 'old-task' }); await migrateSharedMaterials(root);
    const request = vi.fn<typeof fetch>(async (url, init) => {
      expect(init?.method).not.toBe('POST');
      return String(url).includes('/tasks/') ? json({ code: 200, data: { id: 'old-task', status: 'completed', result: { images: [{ url: ['https://images.example.com/old.png'] }] } } }) : new Response(png);
    });
    const service = new ImageService(host, () => ({ ...DEFAULT_IMAGE_SETTINGS, enabled: true }), new PersonaService(host), { fetch: request }); cleanup.push(() => service.dispose());
    expect((await service.generate({ prompt: 'cat', send: true, wait: false }, exec())).status).toBe('completed'); expect(send).not.toHaveBeenCalled();
    expect((await service.status(id, exec('b'))).taskId).toBe('old-task');
    await migrateSharedMaterials(root); expect((await service.status(id, exec('life'))).status).toBe('completed'); expect(request).toHaveBeenCalledTimes(2);
  });
  it('does not resurrect removed public records or resubmit their old invocation after restart', async () => {
    const { root, host } = await setup(); const owner = 'qq:bot:c2c:a', id = serviceHash('old-call').slice(0, 40);
    await seedImage(root, owner, id, png); await migrateSharedMaterials(root);
    const mapped = await migratedOperationId(root, 'images', owner, id);
    await rm(join(root, 'images', publicDir, `${mapped}.json`)); await rm(join(root, 'images', publicDir, `${mapped}.png`));
    await migrateSharedMaterials(root); expect(await readdir(join(root, 'images', publicDir))).toEqual([]);
    const request = vi.fn<typeof fetch>(); const service = new ImageService(host, () => ({ ...DEFAULT_IMAGE_SETTINGS, enabled: true }), new PersonaService(host), { fetch: request }); cleanup.push(() => service.dispose());
    await expect(service.generate({ prompt: 'cat' }, exec())).rejects.toThrow('已删除'); expect(request).not.toHaveBeenCalled();
  });
  it('preserves completed speech collisions, remaps old paths and replays without regeneration', async () => {
    const { root, host, send } = await setup(); const id = serviceHash('old-call').slice(0, 40), a = 'qq:bot:c2c:a', b = 'qq:bot:c2c:b';
    const fingerprint = serviceHash(JSON.stringify({ provider: 'mimo', text: '你好', model: 'mimo-v2.5-tts', voice: 'mimo_default', speed: 1, timeoutMs: 10000, send: true, target: null }));
    for (const [owner, audio] of [[a, wav], [b, Buffer.concat([wav, Buffer.from('different')])]] as const) {
      const base = `speech/${serviceHash(owner).slice(0, 32)}/speech-${id}`;
      await put(root, `${base}.wav`, audio); await put(root, `${base}.json`, { version: 1, fingerprint, state: 'completed', delivery: 'sent', sha256: serviceHash(audio), result: {
        provider: 'mimo', model: 'mimo-v2.5-tts', voice: 'mimo_default', filePath: 'Z:\\old\\voice.wav', fileName: `speech-${id}.wav`, mimeType: 'audio/wav', bytes: audio.length, characters: 2, createdAt: '2026-10-29T00:00:00.000Z', generation: 'completed', delivery: 'sent',
      } });
    }
    expect((await migrateSharedMaterials(root)).speech).toBe(2);
    const voices = await listSpeechFiles(host, exec('b').agent); expect(voices).toHaveLength(2);
    const request = vi.fn<typeof fetch>(); const result = await generateSpeech(host, speechSettings, { text: '你好', send: true }, exec(), { fetch: request });
    expect(await readFile(result.filePath)).toEqual(wav); expect(request).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    const old = join(root, 'speech', serviceHash(a).slice(0, 32), `speech-${id}.wav`);
    expect(await realpath(await resolveSharedMaterialFile(root, old))).toBe(await realpath(result.filePath));
  });
  it('shares old deployments and existing static files while retaining the exact credential and claim ID', async () => {
    const { root, host } = await setup(); const id = 'd'.repeat(40);
    await put(root, `deployments/${id}.json`, { version: 1, owner: 'qq:bot:c2c:a', id, title: 'Old page', fingerprint: 'fp', scriptName: `zeta-${id.slice(0, 20)}`, accountId: 'b'.repeat(32),
      status: 'ready', createdAt: '2026-10-29T00:00:00.000Z', expiresAt: new Date(Date.now() + 60000).toISOString(), fileCount: 1, bytes: 4, previewUrl: 'https://old.preview.workers.dev/' });
    const website = await put(root, `websites/${id}/old-version/index.html`, Buffer.from('page'));
    const report = await migrateSharedMaterials(root); expect(report).toMatchObject({ deployments: 1, websites: 1 });
    const keys = new Map([[id, JSON.stringify({ apiToken: 'backend-only-token', claimUrl: 'https://dash.cloudflare.com/claim-preview?claimToken=private' })]]);
    const service = new DeploymentService(host, () => ({ ...DEFAULT_DEPLOYMENT_SETTINGS, enabled: true, acceptedTerms: true }), { secrets: {
      get: async key => keys.get(key), set: async (key, value) => { keys.set(key, value); }, delete: async key => { keys.delete(key); },
    }, fetch: vi.fn() }); cleanup.push(() => service.dispose());
    expect((await service.list(exec('b').agent))[0]?.id).toBe(id); expect((await service.status(id, exec('life'))).id).toBe(id);
    expect((await service.claim(id)).claimUrl).toContain('private'); expect(await readFile(website, 'utf8')).toBe('page');
    const ledger = await readFile(join(root, 'shared-materials/migration.json'), 'utf8'); expect(ledger).not.toContain('backend-only-token'); expect(ledger).not.toContain('claimToken');
  });
  it('copies colliding historical screenshots and keeps both original paths sendable', async () => {
    const { root } = await setup(); const a = serviceHash('qq:bot:c2c:a').slice(0, 32), b = serviceHash('qq:bot:c2c:b').slice(0, 32);
    const first = await put(root, `browser/screenshots/${a}/same.png`, png), secondBytes = Buffer.concat([png, Buffer.from('second')]);
    const second = await put(root, `browser/screenshots/${b}/same.png`, secondBytes);
    expect((await migrateSharedMaterials(root)).screenshots).toBe(2);
    const firstShared = await resolveSharedMaterialFile(root, first), secondShared = await resolveSharedMaterialFile(root, second);
    expect(await realpath(dirname(firstShared))).toBe(await realpath(join(root, 'browser/screenshots', publicDir))); expect(firstShared).not.toBe(secondShared);
    expect(await readFile(firstShared)).toEqual(png); expect(await readFile(secondShared)).toEqual(secondBytes);
    await rm(firstShared); await migrateSharedMaterials(root); await expect(readFile(firstShared)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['before', 'after'] as const)('retries unsupported-link asset publication interrupted %s rename without partial targets', async when => {
    const { root } = await setup(), folder = serviceHash('qq:bot:c2c:a').slice(0, 32);
    const original = await put(root, `browser/screenshots/${publicDir}/same.png`, png);
    const content = Buffer.concat([png, Buffer.from('private original')]);
    const source = await put(root, `browser/screenshots/${folder}/same.png`, content);
    const sourceKey = `browser/screenshots/${folder}/same.png`;
    const targetName = `same-${serviceHash(`${sourceKey}:${serviceHash(content)}`).slice(0, 20)}.png`;
    const target = join(root, 'browser/screenshots', publicDir, targetName);
    filesystemFault.unsupportedLink = true; filesystemFault.publish = when; filesystemFault.kind = 'asset';
    await expect(migrateSharedMaterials(root)).rejects.toThrow(`publish ${when}`); expect(filesystemFault.linkAttempts).toBe(1);
    if (when === 'before') await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
    else expect(await readFile(target)).toEqual(content);
    expect((await migrateSharedMaterials(root)).screenshots).toBe(1);
    expect(await readFile(await resolveSharedMaterialFile(root, source))).toEqual(content);
    expect(await readFile(original)).toEqual(png); expect(await readFile(source)).toEqual(content);
    await migrateSharedMaterials(root); expect((await readdir(join(root, 'browser/screenshots', publicDir))).sort()).toEqual(['same.png', targetName].sort());
  });
  it.each(['before', 'after'] as const)('persists deployment migration intent before an owner update interrupted %s publish', async when => {
    const { root, host } = await setup(), legacyOwner = 'qq:bot:c2c:a', callId = 'old-deployment-call';
    const id = serviceHash(`${legacyOwner}:${callId}`).slice(0, 40), content = '<h1>Existing page</h1>';
    const fileHash = serviceHash(Buffer.concat([Buffer.from('text/html; charset=utf-8'), Buffer.from(content)])).slice(0, 32);
    const fingerprint = serviceHash(JSON.stringify({ files: [{ path: 'index.html', hash: fileHash }], title: '' }));
    const path = await put(root, `deployments/${id}.json`, { version: 1, owner: legacyOwner, id, title: 'Existing page', fingerprint,
      scriptName: `zeta-${id.slice(0, 20)}`, accountId: 'b'.repeat(32), status: 'ready', createdAt: '2026-10-29T00:00:00.000Z',
      expiresAt: new Date(Date.now() + 60000).toISOString(), fileCount: 1, bytes: Buffer.byteLength(content), previewUrl: 'https://old.preview.workers.dev/' });
    filesystemFault.publish = when; filesystemFault.kind = 'deployment';
    await expect(migrateSharedMaterials(root)).rejects.toThrow(`publish ${when}`);
    expect(await migratedOperationId(root, 'deployments', legacyOwner, id)).toBe(id);
    expect(JSON.parse(await readFile(path, 'utf8')).owner).toBe(when === 'before' ? legacyOwner : PUBLIC_SPACE);
    await migrateSharedMaterials(root); expect(JSON.parse(await readFile(path, 'utf8')).owner).toBe(PUBLIC_SPACE);
    const request = vi.fn<typeof fetch>(), secrets = { get: vi.fn(async () => undefined), set: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
    const service = new DeploymentService(host, () => ({ ...DEFAULT_DEPLOYMENT_SETTINGS, enabled: true, acceptedTerms: true }), { fetch: request, secrets }); cleanup.push(() => service.dispose());
    const input = { files: [{ path: 'index.html', content }] };
    expect((await service.deploy(input, exec('a', callId))).id).toBe(id); expect(request).not.toHaveBeenCalled();
    await rm(path); await migrateSharedMaterials(root);
    await expect(service.deploy(input, exec('a', callId))).rejects.toThrow('已删除'); expect(request).not.toHaveBeenCalled();
  });
  it('repairs a legacy deployment already normalized before its receipt was persisted', async () => {
    const { root } = await setup(), owner = 'qq:bot:c2c:a', id = serviceHash(`${owner}:legacy-window`).slice(0, 40);
    await put(root, `deployments/${id}.json`, { version: 1, owner: PUBLIC_SPACE, id, fingerprint: 'original', status: 'ready' });
    await migrateSharedMaterials(root); expect(await migratedOperationId(root, 'deployments', owner, id)).toBe(id);
    await rm(join(root, 'deployments', `${id}.json`)); await migrateSharedMaterials(root);
    await expect(migratedOperationId(root, 'deployments', owner, id)).rejects.toThrow('已删除');
  });
  it('continues a partial migration without replacing a later public state', async () => {
    const { root } = await setup(); const owner = 'qq:bot:c2c:a', good = '0'.repeat(40), bad = 'f'.repeat(40);
    await seedImage(root, owner, good, png);
    const badPath = await put(root, `images/${serviceHash(owner).slice(0, 32)}/${bad}.json`, Buffer.from('invalid JSON'));
    await expect(migrateSharedMaterials(root)).rejects.toThrow('索引无法读取');
    const mapped = await migratedOperationId(root, 'images', owner, good); const target = join(root, 'images', publicDir, `${mapped}.json`);
    const current = JSON.parse(await readFile(target, 'utf8')); current.notice = 'Progress saved after the first import'; await writeFile(target, JSON.stringify(current));
    await writeFile(badPath, JSON.stringify(imageRecord(owner, bad)));
    await migrateSharedMaterials(root); expect(JSON.parse(await readFile(target, 'utf8')).notice).toContain('Progress saved');
    expect((await readdir(join(root, 'images', publicDir))).filter(name => name.endsWith('.json'))).toHaveLength(2);
  });
  it('refuses linked source directories instead of copying files outside the material root', async () => {
    const { root } = await setup(); const outside = await mkdtemp(join(tmpdir(), 'dsh-zeta-shared-')); roots.push(outside);
    await mkdir(join(root, 'images')); await writeFile(join(outside, 'secret.png'), png);
    await symlink(outside, join(root, 'images', 'a'.repeat(32)), 'junction');
    await expect(migrateSharedMaterials(root)).rejects.toThrow('符号链接');
    await expect(readFile(join(root, 'images', publicDir, 'secret.png'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
describe('shared assets do not share active tasks or delivery authority', () => {
  it('uses one public scope while ending agent A never closes agent B browser', async () => {
    const { host } = await setup(); let next = 0;
    const request = vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST' ? json({ sessionId: `remote-${++next}` }) : json({ status: 'closing' }));
    const browser = { newContext: async () => ({ route: async () => {}, newPage: async () => ({ setDefaultTimeout() {}, url: () => 'https://example.com/', locator: () => ({ innerText: async () => 'text' }) }), close: async () => {} }), close: async () => {} } as unknown as Browser;
    const service = new BrowserService(host, () => ({ ...DEFAULT_BROWSER_SETTINGS, enabled: true, accountId: 'a'.repeat(32), maxConcurrent: 2 }), { fetch: request, connect: async () => browser }); cleanup.push(() => service.dispose());
    expect(scopeFor(host, exec('a').agent)).toBe(PUBLIC_SPACE); expect(scopeFor(host, exec('b').agent)).toBe(PUBLIC_SPACE);
    const a = await service.run({ actions: [{ action: 'read' }], keepSession: true }, exec('a'));
    const b = await service.run({ actions: [{ action: 'read' }], keepSession: true }, exec('b'));
    await expect(service.run({ session: String(a.session), actions: [{ action: 'read' }] }, exec('b'))).rejects.toMatchObject({ code: 'NO_SESSION' });
    await service.closeForAgent(exec('a').agent); expect((await service.status()).active).toBe(1);
    expect((await service.run({ session: String(b.session), actions: [{ action: 'read' }] }, exec('b'))).closed).toBe(true);
  });
  it('keeps identical call IDs from different actors as distinct image submissions in the shared list', async () => {
    const { host } = await setup(); let tasks = 0;
    const request = vi.fn<typeof fetch>(async (url, init) => init?.method === 'POST' ? json({ code: 200, data: [{ task_id: `task-${++tasks}` }] }) : json({ code: 200, data: { id: String(url).split('/').at(-1), status: 'pending' } }));
    const service = new ImageService(host, () => ({ ...DEFAULT_IMAGE_SETTINGS, enabled: true }), new PersonaService(host), { fetch: request }); cleanup.push(() => service.dispose());
    const a = await service.generate({ prompt: 'cat', wait: false }, exec('a', 'same-call'));
    const b = await service.generate({ prompt: 'cat', wait: false }, exec('b', 'same-call'));
    expect(a.id).not.toBe(b.id); expect(tasks).toBe(2); expect(await service.list(exec('a').agent)).toEqual(await service.list(exec('b').agent));
  });
  it('keeps actor idempotency separate while both actors list the same generated speech', async () => {
    const { host } = await setup();
    const request = vi.fn<typeof fetch>(async () => json({ choices: [{ finish_reason: 'stop', message: { audio: { data: wav.toString('base64') } } }] }));
    const a = await generateSpeech(host, speechSettings, { text: '你好' }, exec('a', 'same-call'), { fetch: request });
    const b = await generateSpeech(host, speechSettings, { text: '你好' }, exec('b', 'same-call'), { fetch: request });
    expect(a.filePath).not.toBe(b.filePath); expect(dirname(a.filePath)).toBe(dirname(b.filePath));
    expect((await listSpeechFiles(host, exec('a').agent))).toHaveLength(2); expect(await listSpeechFiles(host, exec('a').agent)).toEqual(await listSpeechFiles(host, exec('b').agent));
    await generateSpeech(host, speechSettings, { text: '你好' }, exec('a', 'same-call'), { fetch: request }); expect(request).toHaveBeenCalledTimes(2);
  });
  it('keeps default deployment IDs actor-specific while explicit IDs remain global', async () => {
    const { root, host } = await setup();
    const request = vi.fn<typeof fetch>(async () => new Response('mock provisioning failure', { status: 503 }));
    const service = new DeploymentService(host, () => ({ ...DEFAULT_DEPLOYMENT_SETTINGS, enabled: true, acceptedTerms: true }), {
      fetch: request, secrets: { get: async () => undefined, set: async () => {}, delete: async () => {} },
    }); cleanup.push(() => service.dispose());
    const input = { files: [{ path: 'index.html', content: '<h1>Public page</h1>' }] };
    await expect(service.deploy(input, exec('a', 'same-call'))).rejects.toThrow();
    await expect(service.deploy(input, exec('b', 'same-call'))).rejects.toThrow();
    const names = (await readdir(join(root, 'deployments'))).filter(name => name.endsWith('.json')); expect(names).toHaveLength(2);
    expect(await service.list(exec('a').agent)).toEqual(await service.list(exec('b').agent));
    const id = names[0]!.slice(0, -5); expect((await service.status(id, exec('b'))).id).toBe(id);
    await expect(service.deploy(input, exec('a', 'same-call'))).rejects.toThrow('未知'); expect(request).toHaveBeenCalledTimes(2);
  });
  it('never sends A pending image to B or an owner-management actor when they query the shared job', async () => {
    for (const queryingActor of ['b', 'owner']) {
      const { host, send } = await setup(); let completed = false;
      const request = vi.fn<typeof fetch>(async (url, init) => init?.method === 'POST' ? json({ code: 200, data: [{ task_id: 'task-a' }] }) :
        String(url).includes('/tasks/') ? json({ code: 200, data: { id: 'task-a', status: completed ? 'completed' : 'pending', ...(completed ? { result: { images: [{ url: ['https://images.example.com/a.png'] }] } } : {}) } }) : new Response(png));
      const service = new ImageService(host, () => ({ ...DEFAULT_IMAGE_SETTINGS, enabled: true }), new PersonaService(host), { fetch: request }); cleanup.push(() => service.dispose());
      const result = await service.generate({ prompt: 'cat', send: true, wait: false }, exec('a'));
      completed = true; const queried = await service.status(result.id, exec(queryingActor));
      expect(queried).toMatchObject({ status: 'completed', delivery: 'not_requested' }); expect(send).not.toHaveBeenCalled();
      await service.status(result.id, exec('a')); expect(send).not.toHaveBeenCalled();
    }
  });
});
