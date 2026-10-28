import { randomUUID } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { legacyMaterialOwner, materialActorKey, migratedOperationId } from "./shared-materials.js";
import { atomicJson, boundedBytes, readServiceJson, registerServiceTool, responseObject, scopeFor, ServiceError, serviceAbort, serviceHash, serviceObject } from "./browser.js";
export const DEFAULT_DEPLOYMENT_SETTINGS = { enabled: false, acceptedTerms: false, maxFiles: 1000,
    maxFileBytes: 5 * 1024 * 1024, maxTotalBytes: 25 * 1024 * 1024, timeoutMs: 60000, maxActive: 3 };
const API = 'https://api.cloudflare.com/client/v4';
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webmanifest': 'application/manifest+json' };
/** Cloudflare's documented bounded SHA-256 checkpoint proof, off the event loop. */
export async function solvePreviewChallenge(challenge, signal) {
    serviceAbort(signal);
    if (typeof challenge.challengeToken !== 'string' || challenge.challengeToken.length > 16384 || typeof challenge.seed !== 'string' ||
        !/^[A-Za-z0-9_-]{43}=?$/u.test(challenge.seed) || Buffer.from(challenge.seed, 'base64url').length !== 32 ||
        !Number.isSafeInteger(challenge.k) || challenge.k < 1 || !Number.isSafeInteger(challenge.g) || challenge.g < 1 ||
        challenge.k * challenge.g > 64_000_000 || challenge.k > 100000)
        throw new ServiceError('INVALID_CHALLENGE', 'Cloudflare 工作量证明参数无效或超过计算上限。');
    return new Promise((resolve, reject) => {
        const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
      const { createHash } = require('node:crypto');
      let checkpoint = createHash('sha256').update(Buffer.from(workerData.seed, 'base64url')).digest();
      const checkpoints = [checkpoint];
      for (let segment = 0; segment < workerData.k; segment++) {
        for (let i = 0; i < workerData.g; i++) checkpoint = createHash('sha256').update(checkpoint).digest();
        checkpoints.push(checkpoint);
      }
      parentPort.postMessage(Buffer.concat(checkpoints).toString('base64'));`, { eval: true, workerData: challenge });
        let settled = false;
        const finish = (error, checkpoints) => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener('abort', abort);
            clearTimeout(timer);
            void worker.terminate();
            if (error)
                reject(error);
            else
                resolve({ challengeToken: challenge.challengeToken, solution: { checkpoints: checkpoints } });
        };
        const abort = () => finish(new ServiceError('ABORTED', '临时部署工作量证明已取消。'));
        const timer = setTimeout(() => finish(new ServiceError('TIMEOUT', '临时部署工作量证明计算超时。')), 60000);
        timer.unref();
        signal.addEventListener('abort', abort, { once: true });
        worker.once('message', (value) => typeof value === 'string' ? finish(undefined, value) : finish(new ServiceError('INVALID_CHALLENGE', '工作量证明结果无效。')));
        worker.once('error', () => finish(new ServiceError('CHALLENGE_FAILED', '工作量证明计算失败。')));
        worker.once('exit', code => { if (!settled)
            finish(new ServiceError('CHALLENGE_FAILED', `工作量证明提前结束（${code}）。`)); });
        if (signal.aborted)
            abort();
    });
}
export class DeploymentService {
    host;
    getSettings;
    options;
    requestFetch;
    running = new Map();
    controllers = new Set();
    pendingWrites = new Set();
    expirations = new Map();
    queue = Promise.resolve();
    stopped = false;
    constructor(host, getSettings, options = {}) {
        this.host = host;
        this.getSettings = getSettings;
        this.options = options;
        this.requestFetch = options.fetch ?? fetch;
    }
    get directory() { return join(this.host.dataDir, 'deployments'); }
    path(id) {
        if (!/^[a-f0-9]{40}$/u.test(id))
            throw new ServiceError('INVALID_ARGUMENT', '临时部署标识无效。');
        return join(this.directory, `${id}.json`);
    }
    serial(run) { const task = this.queue.then(run); this.queue = task.catch(() => { }); return task; }
    public(record) {
        const { version: _version, owner: _owner, actorKey: _actor, accountId: _accountId, scriptName: _scriptName, fingerprint: _fingerprint, ...result } = record;
        return result;
    }
    async load(id) {
        const record = await readServiceJson(this.path(id));
        if (record && (record.version !== 1 || record.id !== id || !/^zeta-[a-f0-9]{20}$/u.test(record.scriptName) ||
            (record.accountId !== undefined && !/^[a-f0-9]{32}$/iu.test(record.accountId))))
            throw new ServiceError('LOCAL_STATE', '临时部署记录无效。');
        return record;
    }
    async settings() {
        const settings = await this.getSettings();
        if (!settings.enabled)
            throw new ServiceError('DISABLED', '临时网页部署已关闭。');
        if (!settings.acceptedTerms)
            throw new ServiceError('TERMS_REQUIRED', '请先在管理页接受 Cloudflare 服务条款和隐私政策。');
        if (!this.options.secrets)
            throw new ServiceError('NO_CREDENTIAL_STORE', 'DSH 临时部署凭据存储不可用。');
        for (const [value, min, max] of [[settings.maxFiles, 1, 1000], [settings.maxFileBytes, 1, 5 * 1024 * 1024],
            [settings.maxTotalBytes, 1, 64 * 1024 * 1024], [settings.timeoutMs, 1000, 120000], [settings.maxActive, 1, 20]]) {
            if (!Number.isInteger(value) || value < min || value > max)
                throw new ServiceError('INVALID_CONFIGURATION', '临时部署限额配置无效。');
        }
        return settings;
    }
    files(input, settings) {
        if (!input || Object.keys(input).some(key => !['id', 'files', 'title'].includes(key)) || !Array.isArray(input.files) ||
            !input.files.length || input.files.length > settings.maxFiles || (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 200)))
            throw new ServiceError('INVALID_ARGUMENT', '网页文件或标题无效。');
        const seen = new Set();
        let total = 0;
        const files = input.files.map(file => {
            if (!file || typeof file.path !== 'string' || typeof file.content !== 'string' || !file.path || file.path.length > 500 ||
                file.path.startsWith('/') || /[\\:\u0000-\u001f]/u.test(file.path) || file.path.split('/').some(segment => !segment || segment.startsWith('.') || /[. ]$/u.test(segment)) ||
                !MIME[extname(file.path).toLowerCase()] || /(^|\/)(?:node_modules|package(?:-lock)?\.json|credentials?\.[^/]*|secrets?\.[^/]*|wrangler\.[^/]*)(\/|$)/iu.test(file.path) || seen.has(file.path.toLowerCase())) {
                throw new ServiceError('INVALID_FILE', '仅允许作品内的公开静态文件；路径、配置文件或重复文件无效。');
            }
            if (file.encoding !== undefined && !['utf8', 'base64'].includes(file.encoding))
                throw new ServiceError('INVALID_FILE', '网页文件编码无效。');
            if (file.content.length > Math.ceil(settings.maxFileBytes * 4 / 3) + 4)
                throw new ServiceError('TOO_LARGE', '网页文件超过大小上限。');
            if (file.encoding === 'base64' && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(file.content)))
                throw new ServiceError('INVALID_FILE', '网页文件 Base64 编码无效。');
            const bytes = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
            if (/\.(?:html|css|js|mjs|json|txt)$/iu.test(file.path) && /-----BEGIN[^\r\n-]*PRIVATE KEY-----|(?:api[_-]?key|client[_-]?secret|access[_-]?token|authorization)\s*[:=]\s*["'][A-Za-z0-9_+/=.-]{12,}["']/iu.test(bytes.toString('utf8'))) {
                throw new ServiceError('SECRET_IN_ARTIFACT', '网页文件中包含疑似密钥，请移除凭据后再发布。');
            }
            total += bytes.length;
            if (bytes.length > settings.maxFileBytes || total > settings.maxTotalBytes)
                throw new ServiceError('TOO_LARGE', '网页文件超过部署大小上限。');
            seen.add(file.path.toLowerCase());
            const mime = MIME[extname(file.path).toLowerCase()];
            return { path: file.path, bytes, mime, hash: serviceHash(Buffer.concat([Buffer.from(mime), bytes])).slice(0, 32) };
        });
        if (!seen.has('index.html'))
            throw new ServiceError('INVALID_FILE', '网页必须包含 index.html。');
        return files;
    }
    async api(path, init, signal, timeoutMs, key) {
        const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
        try {
            const response = await responseObject(await this.requestFetch(`${API}${path}`, { ...init,
                headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...init.headers }, signal: combined, redirect: 'error' }), combined);
            if (response.success !== true)
                throw new ServiceError('PROVIDER_REJECTED', 'Cloudflare 未确认临时部署操作。');
            return response.result == null ? {} : serviceObject(response.result);
        }
        catch (error) {
            if (signal.aborted)
                serviceAbort(signal);
            if (error instanceof ServiceError)
                throw error;
            throw new ServiceError('CONNECTION', 'Cloudflare 请求未确认；不会自动重复创建账户。');
        }
    }
    async secret(id) {
        try {
            const text = await this.options.secrets?.get(id);
            const value = serviceObject(JSON.parse(text ?? 'null'));
            if (typeof value.apiToken !== 'string' || !value.apiToken || typeof value.claimUrl !== 'string' || !value.claimUrl.startsWith('https://dash.cloudflare.com/claim-preview?'))
                throw new Error();
            return value;
        }
        catch {
            throw new ServiceError('CREDENTIAL_EXPIRED', '临时部署凭据不可用；可重新创建预览。');
        }
    }
    expire(record) {
        if (!record.expiresAt || Date.parse(record.expiresAt) > Date.now() || record.status === 'deleted' || record.status === 'expired')
            return Promise.resolve(record);
        const task = (async () => {
            try {
                this.host.requireWritable?.();
            }
            catch {
                this.scheduleExpiry(record, 1000);
                return { ...record, status: 'expired', notice: '临时管理权限已到期。' };
            }
            record.status = 'expired';
            record.notice = '临时管理权限已到期；若已认领，站点保留并由认领账户管理。';
            await this.options.secrets?.delete(record.id);
            await atomicJson(this.path(record.id), record);
            return record;
        })();
        this.pendingWrites.add(task);
        void task.finally(() => this.pendingWrites.delete(task)).catch(() => { });
        return task;
    }
    scheduleExpiry(record, retryMs) {
        clearTimeout(this.expirations.get(record.id));
        if (this.stopped || !record.expiresAt || record.status === 'expired' || record.status === 'deleted')
            return;
        const timer = setTimeout(() => {
            this.expirations.delete(record.id);
            void this.serial(async () => { const current = await this.load(record.id); if (current)
                await this.expire(current); }).catch(() => { });
        }, retryMs ?? Math.max(1, Date.parse(record.expiresAt) - Date.now()));
        timer.unref();
        this.expirations.set(record.id, timer);
    }
    async recover() {
        await mkdir(this.directory, { recursive: true });
        for (const name of await readdir(this.directory)) {
            if (!/^[a-f0-9]{40}\.json$/u.test(name))
                continue;
            const record = await this.load(name.slice(0, -5));
            if (record)
                this.scheduleExpiry(await this.expire(record));
        }
    }
    async deploy(input, exec) {
        serviceAbort(exec.signal);
        if (this.stopped)
            throw new ServiceError('STOPPED', '临时部署服务已停止。');
        const owner = scopeFor(this.host, exec.agent);
        const settings = await this.settings();
        const files = this.files(input, settings);
        await this.options.beforeDeploy?.(input, exec);
        this.host.requireWritable?.();
        if (this.stopped)
            throw new ServiceError('STOPPED', '临时部署服务已停止。');
        const actorKey = materialActorKey(this.host, exec.agent), callId = exec.callId || randomUUID();
        let id = input.id ?? serviceHash(`${actorKey}:${callId}`).slice(0, 40);
        if (!input.id && exec.callId) {
            const oldId = serviceHash(`${legacyMaterialOwner(this.host, exec.agent)}:${callId}`).slice(0, 40);
            await migratedOperationId(this.host.dataDir, 'deployments', legacyMaterialOwner(this.host, exec.agent), oldId);
            const old = await this.load(oldId);
            if (old?.owner === owner && !old.actorKey)
                id = oldId;
        }
        serviceAbort(exec.signal);
        this.host.requireWritable?.();
        this.path(id);
        const fingerprint = serviceHash(JSON.stringify({ files: files.map(file => ({ path: file.path, hash: file.hash })), title: input.title ?? '' }));
        const active = this.running.get(id);
        if (active) {
            const result = await active;
            const record = await this.load(id);
            if (record?.owner !== owner || record.fingerprint !== fingerprint)
                throw new ServiceError('CALL_CONFLICT', '部署调用标识对应不同作品。');
            return result;
        }
        const task = this.deployOnce(owner, id, fingerprint, input, files, settings, exec);
        this.running.set(id, task);
        try {
            return await task;
        }
        finally {
            if (this.running.get(id) === task)
                this.running.delete(id);
        }
    }
    async deployOnce(owner, id, fingerprint, input, files, settings, exec) {
        const controller = new AbortController();
        this.controllers.add(controller);
        const signal = AbortSignal.any([exec.signal, controller.signal]);
        try {
            let record = await this.load(id);
            if (record && record.owner !== owner)
                throw new ServiceError('NO_SCOPE', '不能管理其他对话创建的临时网页。');
            if (record) {
                record = await this.expire(record);
                if (['expired', 'deleted'].includes(record.status))
                    throw new ServiceError('EXPIRED', '此临时部署已结束，请创建新的预览。');
                if (!input.id && record.fingerprint !== fingerprint)
                    throw new ServiceError('CALL_CONFLICT', '相同调用标识对应不同作品。');
                if (record.fingerprint === fingerprint && record.status === 'ready')
                    return this.public(record);
                if (!record.accountId)
                    throw new ServiceError('OUTCOME_UNKNOWN', '此前临时账户创建结果未知，不会自动重复创建。');
            }
            else {
                await this.serial(async () => {
                    await mkdir(this.directory, { recursive: true });
                    let active = 0;
                    for (const name of await readdir(this.directory)) {
                        if (!/^[a-f0-9]{40}\.json$/u.test(name))
                            continue;
                        const previous = await this.load(name.slice(0, -5));
                        if (previous && !['failed', 'deleted', 'expired'].includes((await this.expire(previous)).status))
                            active++;
                    }
                    if (active >= settings.maxActive)
                        throw new ServiceError('BUDGET', '活跃临时网页已达上限，请先删除旧预览。');
                    record = { version: 1, id, owner, actorKey: materialActorKey(this.host, exec.agent), fingerprint, scriptName: `zeta-${id.slice(0, 20)}`, title: input.title?.trim() || '临时网页', status: 'preparing',
                        createdAt: new Date().toISOString(), fileCount: files.length, bytes: files.reduce((sum, file) => sum + file.bytes.length, 0) };
                    await writeFile(this.path(id), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
                });
            }
            if (!record)
                throw new ServiceError('LOCAL_STATE', '无法建立部署记录。');
            const workDirectory = join(this.host.dataDir, 'websites', id, randomUUID());
            await mkdir(workDirectory, { recursive: true });
            for (const file of files) {
                const path = join(workDirectory, ...file.path.split('/'));
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, file.bytes, { flag: 'wx', mode: 0o600 });
            }
            if (!record.accountId) {
                try {
                    const challengeRaw = await this.api('/provisioning/previews/challenge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, signal, settings.timeoutMs);
                    const challenge = challengeRaw;
                    const proof = await (this.options.solveChallenge ?? solvePreviewChallenge)(challenge, signal);
                    const response = await this.api('/provisioning/previews', { method: 'POST', headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ termsOfService: 'https://www.cloudflare.com/terms/', privacyPolicy: 'https://www.cloudflare.com/privacypolicy/', acceptTermsOfService: 'yes', ...proof }),
                    }, signal, settings.timeoutMs);
                    const account = serviceObject(response.account);
                    const claim = serviceObject(response.claim);
                    if (typeof account.id !== 'string' || !/^[a-f0-9]{32}$/iu.test(account.id) || typeof account.apiToken !== 'string' || !account.apiToken ||
                        typeof account.expiresAt !== 'string' || typeof claim.expiresAt !== 'string' || typeof claim.url !== 'string' ||
                        !claim.url.startsWith('https://dash.cloudflare.com/claim-preview?'))
                        throw new ServiceError('INVALID_RESPONSE', 'Cloudflare 临时账户返回值无效。');
                    const expiry = Math.min(Date.parse(account.expiresAt), Date.parse(claim.expiresAt));
                    if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 61 * 60000)
                        throw new ServiceError('INVALID_RESPONSE', 'Cloudflare 临时账户有效期无效。');
                    await this.options.secrets.set(id, JSON.stringify({ apiToken: account.apiToken, claimUrl: claim.url }));
                    record.accountId = account.id;
                    record.expiresAt = new Date(expiry).toISOString();
                    await atomicJson(this.path(id), record);
                    this.scheduleExpiry(record);
                }
                catch (error) {
                    record.status = 'unknown';
                    record.notice = '临时账户创建结果未确认，不会自动重复创建。';
                    await atomicJson(this.path(id), record).catch(() => { });
                    if (error instanceof ServiceError)
                        throw error;
                    throw new ServiceError('OUTCOME_UNKNOWN', 'Cloudflare 临时账户创建结果未知。');
                }
            }
            const secret = await this.secret(id);
            if (!record.accountId)
                throw new ServiceError('LOCAL_STATE', '临时账户标识缺失。');
            const accountPath = `/accounts/${record.accountId}/workers`;
            record.status = 'deploying';
            record.fingerprint = fingerprint;
            record.fileCount = files.length;
            record.bytes = files.reduce((sum, file) => sum + file.bytes.length, 0);
            if (input.title)
                record.title = input.title.trim();
            await atomicJson(this.path(id), record);
            try {
                const manifest = {};
                const byHash = new Map();
                for (const file of files) {
                    manifest[`/${file.path}`] = { hash: file.hash, size: file.bytes.length };
                    byHash.set(file.hash, file);
                }
                const upload = await this.api(`${accountPath}/scripts/${record.scriptName}/assets-upload-session`, {
                    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest }),
                }, signal, settings.timeoutMs, secret.apiToken);
                if (typeof upload.jwt !== 'string' || !upload.jwt || (upload.buckets !== undefined && !Array.isArray(upload.buckets)))
                    throw new ServiceError('INVALID_RESPONSE', 'Cloudflare 未返回素材上传会话。');
                const uploadJwt = upload.jwt;
                let completionJwt = uploadJwt;
                const buckets = (upload.buckets ?? []);
                let completionReceived = !buckets.length;
                for (const bucket of buckets) {
                    if (!Array.isArray(bucket) || !bucket.length || bucket.some(hash => typeof hash !== 'string' || !byHash.has(hash)))
                        throw new ServiceError('INVALID_RESPONSE', 'Cloudflare 素材上传分组无效。');
                    const form = new FormData();
                    for (const hash of bucket) {
                        const file = byHash.get(hash);
                        form.append(hash, new Blob([file.bytes.toString('base64')], { type: file.mime }), file.path.split('/').at(-1));
                    }
                    const response = await this.api(`${accountPath}/assets/upload?base64=true`, { method: 'POST', body: form }, signal, settings.timeoutMs, uploadJwt);
                    if (typeof response.jwt === 'string' && response.jwt) {
                        completionJwt = response.jwt;
                        completionReceived = true;
                    }
                }
                if (!completionReceived)
                    throw new ServiceError('INVALID_RESPONSE', 'Cloudflare 未确认素材全部上传。');
                const form = new FormData();
                form.append('metadata', new Blob([JSON.stringify({ main_module: 'worker.mjs', compatibility_date: '2026-10-28',
                        assets: { jwt: completionJwt, config: { html_handling: 'auto-trailing-slash', not_found_handling: '404-page' } }, bindings: [{ type: 'assets', name: 'ASSETS' }] })], { type: 'application/json' }));
                form.append('worker.mjs', new Blob(['export default { fetch(request, env) { return env.ASSETS.fetch(request); } };'], { type: 'application/javascript+module' }), 'worker.mjs');
                await this.api(`${accountPath}/scripts/${record.scriptName}`, { method: 'PUT', body: form }, signal, settings.timeoutMs, secret.apiToken);
                await this.api(`${accountPath}/scripts/${record.scriptName}/subdomain`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) }, signal, settings.timeoutMs, secret.apiToken);
                const domain = await this.api(`${accountPath}/subdomain`, {}, signal, settings.timeoutMs, secret.apiToken);
                if (typeof domain.subdomain !== 'string' || !/^[a-z0-9-]{1,63}$/u.test(domain.subdomain))
                    throw new ServiceError('INVALID_RESPONSE', 'Cloudflare 未返回临时网页域名。');
                record.previewUrl = `https://${record.scriptName}.${domain.subdomain}.workers.dev/`;
                const verifySignal = AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutMs)]);
                const verification = await this.requestFetch(record.previewUrl, { signal: verifySignal, redirect: 'error' });
                const bytes = await boundedBytes(verification, settings.maxFileBytes + 1024, verifySignal);
                if (!bytes.length)
                    throw new ServiceError('VERIFY_FAILED', '网页已部署，但访问验证返回空内容。');
                record.status = 'ready';
                record.notice = '临时网页已部署并通过访问验证。未认领时约60分钟到期；认领入口仅管理员可见。';
                await atomicJson(this.path(id), record);
                return this.public(record);
            }
            catch (error) {
                record.status = 'unknown';
                record.notice = '部署或验证未确认；可查询当前状态，或使用相同id更新，不会另建临时账户。';
                await atomicJson(this.path(id), record).catch(() => { });
                if (error instanceof ServiceError)
                    throw error;
                throw new ServiceError('DEPLOY_UNKNOWN', '临时网页部署结果未确认，账户与作品已保存。');
            }
        }
        finally {
            this.controllers.delete(controller);
        }
    }
    async status(id, exec) {
        serviceAbort(exec.signal);
        this.host.requireWritable?.();
        let record = await this.load(id);
        if (!record || record.owner !== scopeFor(this.host, exec.agent))
            throw new ServiceError('NOT_FOUND', '当前对话没有此临时部署。');
        serviceAbort(exec.signal);
        this.host.requireWritable?.();
        record = await this.expire(record);
        if (record.status === 'unknown' && record.accountId && !this.running.has(id)) {
            try {
                const secret = await this.secret(id);
                const settings = await this.getSettings();
                const domain = await this.api(`/accounts/${record.accountId}/workers/subdomain`, {}, exec.signal, settings.timeoutMs, secret.apiToken);
                if (typeof domain.subdomain !== 'string' || !/^[a-z0-9-]{1,63}$/u.test(domain.subdomain))
                    throw new ServiceError('INVALID_RESPONSE', '临时网页域名无效。');
                record.previewUrl = `https://${record.scriptName}.${domain.subdomain}.workers.dev/`;
                const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(settings.timeoutMs)]);
                const response = await this.requestFetch(record.previewUrl, { signal, redirect: 'error' });
                const bytes = await boundedBytes(response, settings.maxFileBytes + 1024, signal);
                if (!bytes.length)
                    throw new ServiceError('VERIFY_FAILED', '网页响应为空。');
                record.status = 'ready';
                record.notice = '已确认临时网页可以访问；没有重新创建账户或重新部署。';
                serviceAbort(exec.signal);
                this.host.requireWritable?.();
                await atomicJson(this.path(id), record);
            }
            catch {
                serviceAbort(exec.signal);
                record.notice = '暂时无法确认远端网页；账户与作品仍保留，没有重新创建账户。';
            }
        }
        return this.public(record);
    }
    async list(agent) {
        const owner = scopeFor(this.host, agent);
        const result = [];
        let names;
        try {
            names = await readdir(this.directory);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return [];
            throw error;
        }
        for (const name of names.filter(name => /^[a-f0-9]{40}\.json$/u.test(name))) {
            const record = await this.load(name.slice(0, -5));
            if (record?.owner === owner)
                result.push(this.public(await this.expire(record)));
        }
        return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    /** Authenticated administrator API only. Never register as a model tool. */
    async claim(id) {
        const record = await this.load(id);
        if (!record || !record.expiresAt || Date.parse(record.expiresAt) <= Date.now() || ['expired', 'deleted'].includes(record.status)) {
            if (record)
                await this.expire(record);
            throw new ServiceError('EXPIRED', '此临时账户已经到期或移除。');
        }
        const secret = await this.secret(id);
        return { claimUrl: secret.claimUrl, expiresAt: record.expiresAt };
    }
    async remove(id, exec) {
        this.host.requireWritable?.();
        serviceAbort(exec.signal);
        const record = await this.load(id);
        if (!record || record.owner !== scopeFor(this.host, exec.agent))
            throw new ServiceError('NOT_FOUND', '当前对话没有此临时部署。');
        serviceAbort(exec.signal);
        this.host.requireWritable?.();
        await this.expire(record);
        if (record.status === 'expired' || record.status === 'deleted')
            return this.public(record);
        if (this.running.has(id))
            throw new ServiceError('BUSY', '网页正在部署中，请稍后删除。');
        if (record.accountId) {
            const secret = await this.secret(id);
            const settings = await this.getSettings();
            await this.api(`/accounts/${record.accountId}/workers/scripts/${record.scriptName}`, { method: 'DELETE' }, exec.signal, settings.timeoutMs, secret.apiToken);
        }
        record.status = 'deleted';
        record.notice = '临时网页已删除。';
        await atomicJson(this.path(id), record);
        await this.options.secrets?.delete(id);
        clearTimeout(this.expirations.get(id));
        this.expirations.delete(id);
        return this.public(record);
    }
    async quiesce() {
        for (const controller of this.controllers)
            controller.abort();
        await Promise.allSettled([...this.running.values()]);
        await this.queue;
        await Promise.allSettled([...this.pendingWrites]);
    }
    async dispose() {
        this.stopped = true;
        for (const timer of this.expirations.values())
            clearTimeout(timer);
        this.expirations.clear();
        await this.quiesce();
    }
}
export function registerDeploymentTools(service) {
    registerServiceTool(service.host, { name: 'zeta_deploy_page', description: '将提供的公开静态作品文件部署到Cloudflare临时账户，返回真实预览URL和到期时间。必须包含index.html；支持HTML/CSS/JS及图片，不执行本机脚本，不读取任意本机文件。更新时传旧id。勿上传聊天记录、密钥或配置。约60分钟未认领会失效；认领链接仅管理页可见。',
        parameters: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, files: { type: 'array', minItems: 1, maxItems: 1000,
                    items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, encoding: { type: 'string', enum: ['utf8', 'base64'] } }, required: ['path', 'content'], additionalProperties: false } } }, required: ['files'], additionalProperties: false },
        execute: (input, exec) => service.deploy(input, exec) });
    registerServiceTool(service.host, { name: 'zeta_deploy_status', description: '查询当前对话创建的临时网页及到期状态，不暴露账户凭据或认领链接。',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, execute: (input, exec) => service.status(input.id, exec) });
    registerServiceTool(service.host, { name: 'zeta_deploy_delete', description: '删除当前对话创建的临时网页。不能删除其他对话或正式Cloudflare账户的部署。',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, execute: (input, exec) => service.remove(input.id, exec) });
}
//# sourceMappingURL=deployments.js.map