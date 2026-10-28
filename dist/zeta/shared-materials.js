import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { PUBLIC_SPACE } from "./state.js";
const hash = (value) => createHash('sha256').update(value).digest('hex');
const publicDirectory = hash(PUBLIC_SPACE).slice(0, 32);
const slash = (value) => value.replaceAll('\\', '/');
const running = new Map();
const MAX_FILE_BYTES = 256 * 1024 * 1024;
export class SharedMaterialMigrationError extends Error {
    constructor(message) { super(message); this.name = 'SharedMaterialMigrationError'; }
}
function object(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new SharedMaterialMigrationError('旧素材记录格式无效。');
    return value;
}
function contained(path, root) {
    const rel = relative(root, path);
    return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
}
async function checked(root, path) {
    const target = resolve(root, path);
    if (!contained(target, root))
        throw new SharedMaterialMigrationError('素材路径超出插件目录。');
    let current = root;
    for (const part of relative(root, target).split(/[\\/]/u).filter(Boolean)) {
        current = join(current, part);
        try {
            if ((await lstat(current)).isSymbolicLink())
                throw new SharedMaterialMigrationError('素材目录包含符号链接，未读取或覆盖其目标。');
        }
        catch (error) {
            if (error.code === 'ENOENT')
                break;
            throw error;
        }
    }
    return target;
}
async function bytes(root, path, maximum = MAX_FILE_BYTES) {
    const target = await checked(root, path);
    try {
        const stat = await lstat(target);
        if (!stat.isFile() || stat.size > maximum)
            throw new SharedMaterialMigrationError(`素材文件类型或大小无效：${slash(relative(root, target))}`);
        return await readFile(target);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
async function readLedger(root) {
    const data = await bytes(root, 'shared-materials/migration.json', 16 * 1024 * 1024);
    if (!data)
        return { version: 1, entries: {}, files: {} };
    let value;
    try {
        value = JSON.parse(data.toString('utf8'));
    }
    catch {
        throw new SharedMaterialMigrationError('公共素材迁移收据无法读取，未重新导入旧素材。');
    }
    if (value.version !== 1 || !value.entries || !value.files || Array.isArray(value.entries) || Array.isArray(value.files))
        throw new SharedMaterialMigrationError('公共素材迁移收据版本无效。');
    for (const receipt of [...Object.values(value.entries), ...Object.values(value.files)]) {
        if (!receipt || typeof receipt.sourceHash !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.sourceHash) || typeof receipt.target !== 'string' || isAbsolute(receipt.target))
            throw new SharedMaterialMigrationError('公共素材迁移路径收据无效。');
        await checked(root, receipt.target);
    }
    return value;
}
async function atomic(root, path, value) {
    const target = await checked(root, path);
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
        await writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
        await rename(temp, target);
    }
    finally {
        await unlink(temp).catch(() => { });
    }
}
async function copyAtomic(root, path, data) {
    const target = await checked(root, path), previous = await bytes(root, path);
    if (previous) {
        if (hash(previous) !== hash(data))
            throw new SharedMaterialMigrationError('公共素材同名文件内容不同，未覆盖原文件。');
        return;
    }
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, data, { flag: 'wx', mode: 0o600 });
    try {
        try {
            await link(temp, target);
        }
        catch (error) {
            if (['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EXDEV'].includes(error.code ?? '')) {
                // Startup migration is the only writer until service registration; the
                // per-root promise also serializes concurrent calls in this process.
                // Publish only the fully written adjacent temp, never copy into target.
                const current = await bytes(root, path);
                if (current) {
                    if (hash(current) !== hash(data))
                        throw new SharedMaterialMigrationError('公共素材同名文件内容不同，未覆盖原文件。');
                }
                else
                    await rename(temp, target);
            }
            else if (error.code !== 'EEXIST' || hash((await bytes(root, path))) !== hash(data))
                throw error;
        }
    }
    finally {
        await unlink(temp).catch(() => { });
    }
}
async function names(root, path) {
    const target = await checked(root, path);
    try {
        return (await readdir(target)).sort();
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
}
/** A stable call identity is separate from the one shared material namespace. */
export function materialActorKey(host, agent) {
    const binding = host.bindingFor(agent), life = host.isLifeAgent(agent);
    if (!binding && !life)
        throw new SharedMaterialMigrationError('当前调用没有可信会话身份。');
    const value = agent;
    const id = value?.session?.id ?? value?.id ?? binding?.sessionId;
    if (typeof id === 'string' && id)
        return `session:${id}`;
    if (binding)
        return `route:${binding.appId}:${binding.scope}:${binding.peerId}`;
    return 'life:self';
}
export function legacyMaterialOwner(host, agent) { return host.bindingFor(agent)?.key ?? PUBLIC_SPACE; }
export async function migratedOperationId(dataDir, kind, legacyOwner, operation) {
    let root;
    try {
        root = await realpath(dataDir);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
    const ledger = await readLedger(root);
    const source = kind === 'deployments' ? `deployments/${operation}.json` : `${kind}/${hash(legacyOwner).slice(0, 32)}/${kind === 'speech' ? 'speech-' : ''}${operation}.json`;
    const receipt = ledger.entries[source];
    if (receipt && !await bytes(root, receipt.target, 4 * 1024 * 1024))
        throw new SharedMaterialMigrationError('此前迁移的任务记录已删除，不会重新提交收费请求或创建账户。');
    return receipt?.id;
}
/** Resolve historical local paths before the caller applies public-root authorization. */
export async function resolveSharedMaterialFile(dataDir, absolutePath) {
    if (!isAbsolute(absolutePath))
        return absolutePath;
    let root;
    try {
        root = await realpath(dataDir);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return absolutePath;
        throw error;
    }
    const lexicalRoot = resolve(dataDir), input = resolve(absolutePath);
    if (!contained(input, lexicalRoot) && !contained(input, root))
        return absolutePath;
    const source = slash(relative(contained(input, lexicalRoot) ? lexicalRoot : root, input));
    const receipt = (await readLedger(root)).files[source];
    return receipt ? checked(root, receipt.target) : absolutePath;
}
/** Merge old namespaces without deleting sources, charging providers or sending QQ. */
export async function migrateSharedMaterials(dataDir) {
    await mkdir(dataDir, { recursive: true });
    const root = await realpath(dataDir);
    const existing = running.get(root);
    if (existing)
        return existing;
    const promise = migrate(root);
    running.set(root, promise);
    try {
        return await promise;
    }
    finally {
        if (running.get(root) === promise)
            running.delete(root);
    }
}
async function migrate(root) {
    const ledger = await readLedger(root);
    const report = { speech: 0, images: 0, deployments: 0, screenshots: 0, files: 0, conflicts: 0, alreadyMigrated: 0, websites: 0 };
    const save = () => atomic(root, 'shared-materials/migration.json', ledger);
    async function receipt(source, sourceHash, target, id) {
        ledger.entries[source] = { sourceHash, target, ...(id ? { id } : {}) };
        await save();
    }
    async function copyAsset(source, target, data) {
        await copyAtomic(root, target, data);
        ledger.files[source] = { sourceHash: hash(data), target };
    }
    async function migrateRecord(kind, folder, name) {
        const source = `${kind}/${folder}/${name}`, data = (await bytes(root, source, 4 * 1024 * 1024));
        const sourceHash = hash(data), oldReceipt = ledger.entries[source];
        if (oldReceipt && (oldReceipt.sourceHash === sourceHash || oldReceipt.target === source)) {
            report.alreadyMigrated++;
            return;
        }
        if (Object.values(ledger.entries).some(item => item.target === source)) {
            report.alreadyMigrated++;
            return;
        }
        let original;
        try {
            original = object(JSON.parse(data.toString('utf8')));
        }
        catch {
            throw new SharedMaterialMigrationError(`旧素材索引无法读取：${source}`);
        }
        if (original.version !== 1 || typeof original.fingerprint !== 'string')
            throw new SharedMaterialMigrationError(`旧素材索引版本无效：${source}`);
        if (folder === publicDirectory && typeof original.actorKey === 'string')
            return;
        const oldId = name.replace(/^speech-/u, '').replace(/\.json$/u, '');
        let extension = kind === 'speech' ? 'wav' : original.mimeType === 'image/jpeg' ? 'jpg' : original.mimeType === 'image/webp' ? 'webp' : 'png';
        let sourceAsset = `${kind}/${folder}/${kind === 'speech' ? 'speech-' : ''}${oldId}.${extension}`;
        let asset = await bytes(root, sourceAsset);
        if (!asset && kind === 'images') {
            for (const ext of ['png', 'jpg', 'webp']) {
                const path = `${kind}/${folder}/${oldId}.${ext}`, candidate = await bytes(root, path);
                if (candidate) {
                    extension = ext;
                    sourceAsset = path;
                    asset = candidate;
                    break;
                }
            }
        }
        const completed = kind === 'speech' ? original.state === 'completed' : original.status === 'completed';
        if (completed && !asset)
            throw new SharedMaterialMigrationError(`已完成素材缺少实际原件：${source}`);
        if (asset && typeof original.sha256 === 'string' && original.sha256 !== hash(asset))
            throw new SharedMaterialMigrationError(`旧素材原件校验失败：${sourceAsset}`);
        for (let attempt = 0; attempt < 100; attempt++) {
            const id = attempt === 0 ? oldId : hash(`${source}:${sourceHash}:${attempt}`).slice(0, 40);
            const prefix = kind === 'speech' ? 'speech-' : '';
            const target = `${kind}/${publicDirectory}/${prefix}${id}.json`, targetAsset = `${kind}/${publicDirectory}/${prefix}${id}.${extension}`;
            const value = structuredClone(original);
            if (kind === 'speech') {
                if (value.result) {
                    const result = object(value.result);
                    result.fileName = `${prefix}${id}.${extension}`;
                    result.filePath = join(root, ...targetAsset.split('/'));
                }
            }
            else {
                value.owner = PUBLIC_SPACE;
                value.id = id;
                value.send = false;
                if (asset) {
                    value.filePath = join(root, ...targetAsset.split('/'));
                    value.mimeType = extension === 'jpg' ? 'image/jpeg' : `image/${extension}`;
                }
                else
                    delete value.filePath;
            }
            if (asset)
                value.sha256 = hash(asset);
            const existingData = await bytes(root, target, 4 * 1024 * 1024), existingAsset = await bytes(root, targetAsset);
            let sameRecord = !existingData;
            if (existingData) {
                try {
                    sameRecord = JSON.stringify(JSON.parse(existingData.toString('utf8'))) === JSON.stringify(value);
                }
                catch {
                    sameRecord = false;
                }
            }
            // An old public manifest is intentionally normalized in place; private
            // sources never replace a different record or a different byte stream.
            const ownPublicSource = source === target;
            if ((!sameRecord && !ownPublicSource) || (asset && existingAsset && hash(asset) !== hash(existingAsset))) {
                if (attempt === 0)
                    report.conflicts++;
                continue;
            }
            if (asset)
                await copyAsset(sourceAsset, targetAsset, asset);
            if (!sameRecord || !existingData)
                await atomic(root, target, value);
            await receipt(source, sourceHash, target, id);
            report[kind]++;
            return;
        }
        throw new SharedMaterialMigrationError(`公共素材存在过多同名冲突：${source}`);
    }
    for (const kind of ['speech', 'images']) {
        const folders = (await names(root, kind)).filter(name => /^[a-f0-9]{32}$/u.test(name));
        // Normalize pre-existing public records before importing private namespaces.
        folders.sort((a, b) => Number(b === publicDirectory) - Number(a === publicDirectory) || a.localeCompare(b));
        for (const folder of folders)
            for (const name of await names(root, `${kind}/${folder}`)) {
                if ((kind === 'speech' ? /^speech-[a-f0-9]{40}\.json$/u : /^[a-f0-9]{40}\.json$/u).test(name))
                    await migrateRecord(kind, folder, name);
            }
    }
    // Copy any original referenced outside a completed index too. Receipts keep
    // explicitly removed public files from being resurrected on later startups.
    for (const [base, extensions] of [['speech', ['.wav']], ['images', ['.png', '.jpg', '.jpeg', '.webp']], ['browser/screenshots', ['.png']]]) {
        for (const folder of (await names(root, base)).filter(name => /^[a-f0-9]{32}$/u.test(name))) {
            for (const name of await names(root, `${base}/${folder}`)) {
                if (!extensions.includes(extname(name).toLowerCase()))
                    continue;
                const source = `${base}/${folder}/${name}`, asset = (await bytes(root, source)), sourceHash = hash(asset);
                if (ledger.files[source]?.sourceHash === sourceHash || folder === publicDirectory)
                    continue;
                let target = `${base}/${publicDirectory}/${name}`;
                const current = await bytes(root, target);
                if (current && hash(current) !== sourceHash) {
                    report.conflicts++;
                    target = `${base}/${publicDirectory}/${basename(name, extname(name))}-${hash(`${source}:${sourceHash}`).slice(0, 20)}${extname(name)}`;
                }
                await copyAsset(source, target, asset);
                await save();
                report.files++;
                if (base === 'browser/screenshots')
                    report.screenshots++;
            }
        }
    }
    // Deployment IDs address native credentials as well as files. Keep them exact.
    for (const name of await names(root, 'deployments')) {
        if (!/^[a-f0-9]{40}\.json$/u.test(name))
            continue;
        const path = `deployments/${name}`, data = (await bytes(root, path, 4 * 1024 * 1024));
        let record;
        try {
            record = object(JSON.parse(data.toString('utf8')));
        }
        catch {
            throw new SharedMaterialMigrationError(`临时网页记录无效：${name}`);
        }
        if (record.version !== 1 || record.id !== name.slice(0, -5))
            throw new SharedMaterialMigrationError(`临时网页标识无效：${name}`);
        if (record.owner !== PUBLIC_SPACE) {
            // This receipt is also an intent: it must survive before owner is changed
            // in place, so an interrupted import can never lose old-call idempotency.
            if (!ledger.entries[path])
                await receipt(path, hash(data), path, String(record.id));
            record.owner = PUBLIC_SPACE;
            await atomic(root, path, record);
            report.deployments++;
        }
        else if (!record.actorKey && !ledger.entries[path]) {
            // Repair the old normalize-before-receipt interruption window too. The
            // global ID still addresses the original native credential and call.
            await receipt(path, hash(data), path, String(record.id));
        }
    }
    async function checkWebsite(path) {
        for (const name of await names(root, path)) {
            const target = await checked(root, `${path}/${name}`), stat = await lstat(target);
            if (stat.isDirectory())
                await checkWebsite(`${path}/${name}`);
            else if (stat.isFile())
                report.websites++;
        }
    }
    await checkWebsite('websites');
    return report;
}
//# sourceMappingURL=shared-materials.js.map