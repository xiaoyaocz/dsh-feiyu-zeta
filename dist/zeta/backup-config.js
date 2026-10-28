import { isVolatile } from '@deepseek-ai/cosmokit';
import { credentialKey, credentialRef, isCredentialKeySegment, isCredentialRefName, parseCredentialKey } from '@deepseek-ai/dsh-credentials';
import { redactSecrets } from '@deepseek-ai/dsh-settings';
import { isDeepStrictEqual } from 'node:util';
import { isAbsolute } from 'node:path';
import { ConfigSchema } from "../config.js";
import { resolveEnv, PLUGIN_PACKAGE_ALIASES } from "../shared/utils.js";
import { readScheduleConfiguration } from "./schedule-bridge.js";
const MODEL_NAMES = new Set([
    '@deepseek-ai/dsh-agent-default-model', '@deepseek-ai/dsh-llm-deepseek-api-key',
    '@deepseek-ai/dsh-llm-deepseek-account', '@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-deepseek-account-platform',
]);
const DEFAULT_MODEL = '@deepseek-ai/dsh-agent-default-model';
const PI = '@deepseek-ai/dsh-llm-pi-ai';
const API_KEY = '@deepseek-ai/dsh-llm-deepseek-api-key';
const ACCOUNT = '@deepseek-ai/dsh-llm-deepseek-account';
const PLATFORM = '@deepseek-ai/dsh-deepseek-account-platform';
const TTS_REFS = ['ZETA_MIMO_API_KEY', 'ZETA_MINIMAX_API_KEY', 'ZETA_CLOUDFLARE_API_TOKEN', 'ZETA_APIMART_API_KEY'];
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor', '__jsExpr']);
const QQ_KEYS = new Set(['zeta', 'appId', 'appSecret', 'provider', 'model', 'preset', 'cwd', 'requireMention', 'groupPrompt', 'directPrompt',
    'textChunkLimit', 'streaming', 'sessionIdleTimeout', 'maxQueue', 'processingTimeoutMs', 'askTimeoutMs', 'historyLimit', 'access',
    'showToolResults', 'debug', 'media', 'vision', 'sendFile']);
function refusal(message = '迁移配置格式无效，未修改本机设置') { throw new Error(message); }
function object(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        refusal();
    return value;
}
function string(value, max = 65536) {
    if (typeof value !== 'string' || !value || value.length > max || value.includes('\u0000'))
        refusal();
    return value;
}
function keys(value, allowed) {
    if (Object.keys(value).some(key => !allowed.includes(key)))
        refusal();
}
function json(value, depth = 0) {
    if (depth > 64)
        refusal();
    if (value === null || typeof value === 'boolean' || typeof value === 'string')
        return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            refusal();
        return value;
    }
    if (Array.isArray(value)) {
        if (value.length > 20000)
            refusal();
        return value.map(item => json(item, depth + 1));
    }
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        refusal();
    const result = {};
    for (const [key, member] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.has(key))
            refusal('迁移包包含不允许的配置表达式或对象字段');
        result[key] = json(member, depth + 1);
    }
    return result;
}
function detached(value) {
    const result = object(json(plain(value)));
    if (JSON.stringify(result).length > 4 * 1024 * 1024)
        refusal('模型配置过大');
    return result;
}
function plain(value, depth = 0) {
    if (depth > 64)
        refusal();
    if (isVolatile(value))
        return plain(value.get(), depth + 1);
    if (Array.isArray(value))
        return Array.from(value, (member, index) => {
            if (!Object.hasOwn(value, index))
                refusal();
            return plain(member, depth + 1);
        });
    if (value && typeof value === 'object') {
        if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
            refusal();
        const result = {};
        for (const [key, member] of Object.entries(value)) {
            if (FORBIDDEN_KEYS.has(key))
                refusal('迁移包包含不允许的配置表达式或对象字段');
            // Native optional volatile fields are references even when get() yields
            // undefined. Omit absent object fields only after sampling the reference.
            const current = plain(member, depth + 1);
            if (current !== undefined)
                result[key] = current;
        }
        return result;
    }
    return value;
}
function merge(base, patch) {
    const result = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        const before = result[key];
        result[key] = value && typeof value === 'object' && !Array.isArray(value) && before && typeof before === 'object' && !Array.isArray(before)
            ? merge(before, value) : value;
    }
    return result;
}
function effective(row) {
    return detached(row.entry.fiber?.config ?? merge(row.inherited, row.override));
}
function entryId(entry) { return entry.options.id; }
function sensitive(key) {
    if (key === 'apiKeyEnv')
        return false;
    const normalized = key.toLowerCase().replace(/[_-]/gu, '');
    return ['headers', 'env', 'key', 'auth', 'authorization', 'credential', 'credentials'].includes(normalized)
        || /secret|password|passwd|apikey|privatekey|accesskey|cookie|token$/u.test(normalized);
}
function scrub(value) {
    if (Array.isArray(value))
        return value.map(scrub);
    if (!value || typeof value !== 'object')
        return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !sensitive(key)).map(([key, member]) => [key, scrub(member)]));
}
function redacted(row, value) {
    const schema = row.entry.fiber?.runtime?.Config;
    const stripped = schema && 'toJSON' in schema
        ? redactSecrets(schema, value).value : value;
    return detached(scrub(stripped));
}
function providerDirectory(ctx) {
    return ctx?.llm.listConfigurableProviders() ?? [];
}
function profileAt(value, path) {
    let current = value;
    for (const key of path) {
        if (FORBIDDEN_KEYS.has(key) || !current || typeof current !== 'object' || Array.isArray(current))
            return undefined;
        current = Object.hasOwn(current, key) ? current[key] : undefined;
    }
    return current;
}
function assignPath(value, path, item) {
    let current = value;
    for (const key of path.slice(0, -1)) {
        if (FORBIDDEN_KEYS.has(key))
            refusal();
        current[key] ??= {};
        current = object(current[key]);
    }
    const leaf = path.at(-1);
    if (leaf === undefined)
        Object.assign(value, item);
    else {
        if (FORBIDDEN_KEYS.has(leaf))
            refusal();
        current[leaf] = item;
    }
}
function providerNames(value) {
    const providers = new Set();
    if (typeof value.qq.provider === 'string' && value.qq.provider)
        providers.add(value.qq.provider);
    const vision = value.qq.vision;
    if (vision && typeof vision === 'object' && !Array.isArray(vision) && typeof vision.provider === 'string' && vision.provider)
        providers.add(vision.provider);
    for (const model of value.models) {
        if (model.name === DEFAULT_MODEL && typeof model.config.provider === 'string')
            providers.add(model.config.provider);
        if (model.name === PI)
            for (const provider of Object.keys(object(model.config.providers ?? {})))
                providers.add(provider);
        if (model.name === ACCOUNT || model.name === PLATFORM)
            providers.add('deepseek-account');
        if (model.name === API_KEY)
            providers.add('deepseek-official');
    }
    return providers;
}
function allowedReferences(value, ctx) {
    const references = new Set(TTS_REFS);
    for (const model of value.models) {
        if (model.name === API_KEY)
            references.add(typeof model.config.apiKeyEnv === 'string' ? model.config.apiKeyEnv : 'DEEPSEEK_API_KEY');
        if (model.name === PI)
            for (const profile of Object.values(object(model.config.providers ?? {}))) {
                const ref = object(profile).apiKeyEnv;
                if (ref !== undefined)
                    references.add(string(ref, 240));
            }
    }
    const providers = providerNames(value);
    for (const provider of providerDirectory(ctx))
        if (providers.has(provider.provider)) {
            for (const name of provider.nativeAuth?.env ?? [])
                if (isCredentialRefName(name))
                    references.add(name);
        }
    return references;
}
function allowedRecords(value) {
    const result = new Set();
    for (const model of value.models)
        if (model.name === PI)
            for (const provider of Object.keys(object(model.config.providers ?? {}))) {
                if (isCredentialKeySegment(provider))
                    result.add(credentialKey('llm-pi-ai', provider));
            }
    if (providerNames(value).has('deepseek-account')) {
        result.add(credentialKey('deepseek-account-platform', 'default'));
        result.add(credentialKey('deepseek-account-platform', 'device'));
    }
    return result;
}
function modelEntry(ctx, model) {
    const entries = ctx.configEditor.entries().filter(entry => entry.options.name === model.name);
    const matching = entries.find(entry => entryId(entry) === model.id);
    if (matching)
        return matching;
    if (entries.length === 1)
        return entries[0];
    refusal(`目标DSH缺少或无法唯一定位模型组件 ${model.name}，请先安装匹配组件后再恢复`);
}
function qqEntry(ctx) {
    const entries = ctx.configEditor.entries().filter(entry => entry.options.id === 'im-qqbot' && PLUGIN_PACKAGE_ALIASES.some(name => entry.options.name === name));
    if (entries.length !== 1)
        refusal('目标DSH未安装可管理的dsh-feiyu-zeta入口，请先安装插件');
    return entries[0];
}
function scheduleEntry(ctx) {
    const entries = ctx.configEditor.entries().filter(entry => entry.options.id === 'zeta-schedule-bridge'
        && PLUGIN_PACKAGE_ALIASES.some(name => entry.options.name === `${name}/schedule-bridge`) && !entry.options.disabled && entry.fiber?.state === 2);
    if (entries.length !== 1)
        refusal('目标DSH缺少可配置的自动任务迁移组件，请先安装并启用相同版本dsh-feiyu-zeta');
    return entries[0];
}
function scheduleRetention(value) {
    const config = object(value);
    keys(config, ['deliveryHistoryDays', 'deliveryHistoryRecords']);
    for (const [key, maximum] of [['deliveryHistoryDays', 3650], ['deliveryHistoryRecords', 10000]]) {
        if (typeof config[key] !== 'number' || !Number.isSafeInteger(config[key]) || config[key] < 1 || config[key] > maximum)
            refusal('自动任务历史保留设置必须是允许范围内的整数');
    }
    return { deliveryHistoryDays: config.deliveryHistoryDays, deliveryHistoryRecords: config.deliveryHistoryRecords };
}
/** Read only this plugin and the first-party routes it actually uses. Never enumerate all secrets. */
export async function exportConfiguration(ctx, qqEffectiveConfig, includeCredentials, signal, providers = []) {
    signal.throwIfAborted();
    const warnings = [];
    const qq = detached(qqEffectiveConfig);
    for (const [field, environment] of [['appId', 'QQBOT_APPID'], ['appSecret', 'QQBOT_SECRET']]) {
        if (field === 'appSecret' && !includeCredentials) {
            delete qq[field];
            continue;
        }
        if (typeof qq[field] === 'string') {
            const resolved = resolveEnv(qq[field], environment);
            if (resolved)
                qq[field] = resolved;
            else
                delete qq[field];
        }
    }
    if (!includeCredentials)
        delete qq.appSecret;
    const rows = ctx.configEditor.configuration();
    const available = rows.filter(row => MODEL_NAMES.has(row.entry.options.name));
    const directory = providerDirectory(ctx);
    const used = new Set(providers.filter(provider => typeof provider === 'string' && provider));
    if (typeof qq.provider === 'string' && qq.provider)
        used.add(qq.provider);
    if (qq.vision && typeof qq.vision === 'object') {
        const provider = qq.vision.provider;
        if (typeof provider === 'string' && provider)
            used.add(provider);
    }
    const selected = new Map();
    const add = (row, config) => {
        const id = entryId(row.entry);
        const previous = selected.get(id);
        selected.set(id, { id, name: row.entry.options.name, config: merge(previous?.config ?? {}, includeCredentials ? config : redacted(row, config)) });
    };
    const defaultRow = available.find(row => row.entry.options.name === DEFAULT_MODEL);
    const defaultService = ctx.get('agentDefaultModel');
    const selection = defaultService?.currentSelection();
    if (defaultRow) {
        const config = effective(defaultRow);
        const active = selection ? detached(selection) : config;
        if (typeof active.provider === 'string' && active.provider && typeof active.model === 'string' && active.model) {
            used.add(active.provider);
            add(defaultRow, active);
        }
        else
            warnings.push('DSH尚未选择默认模型，恢复后需重新选择');
    }
    else if (selection)
        refusal('当前DSH无法定位默认模型配置入口，不能生成完整迁移配置');
    for (const provider of used) {
        signal.throwIfAborted();
        const declaration = directory.find(item => item.provider === provider);
        const row = declaration ? available.find(item => entryId(item.entry) === declaration.settingsNs || item.entry.id === declaration.settingsNs)
            : available.find(item => provider === 'deepseek-official' ? item.entry.options.name === API_KEY : provider === 'deepseek-account' && item.entry.options.name === ACCOUNT);
        if (!row) {
            warnings.push(`未包含提供方 ${provider} 的配置：未找到受支持的原生模型入口，新机需单独配置`);
            continue;
        }
        const config = effective(row);
        if (row.entry.options.name === PI) {
            const path = declaration?.settingsPath ?? ['providers', provider];
            if (path[0] !== 'providers' || path.length !== 2 || path[1] !== provider)
                refusal('原生模型目录给出了不支持的提供方配置路径');
            const subset = {};
            assignPath(subset, path, detached(profileAt(config, path) ?? {}));
            add(row, subset);
        }
        else
            add(row, config);
        if (declaration?.baseURLEnv?.length)
            warnings.push(`提供方 ${provider} 可依赖本机端点环境；恢复后请核对其服务地址`);
        if (provider === 'deepseek-account') {
            const account = available.find(item => item.entry.options.name === PLATFORM);
            if (account)
                add(account, effective(account));
            warnings.push('账号授权已按选择归档；服务端可能要求新机重新登录，不能保证令牌跨机器有效');
        }
    }
    const schedule = readScheduleConfiguration(ctx);
    const value = { qq: includeCredentials ? qq : detached(scrub(qq)), models: [...selected.values()], references: [], records: [],
        ...(schedule ? { schedule: scheduleRetention(schedule) } : {}), includesCredentials: includeCredentials, warnings };
    if (includeCredentials) {
        for (const name of allowedReferences(value, ctx)) {
            signal.throwIfAborted();
            if (!isCredentialRefName(name))
                refusal('模型凭据引用名称无效');
            const resolved = await ctx.credentials.resolve(credentialRef(name));
            if (resolved)
                value.references.push({ name, value: resolved.value });
        }
        for (const key of allowedRecords(value)) {
            signal.throwIfAborted();
            const record = await ctx.credentials.readRecord(parseCredentialKey(key));
            if (record)
                value.records.push({ key, record: json(record) });
        }
    }
    signal.throwIfAborted();
    return validateConfiguration(value, ctx);
}
/** Validate an untrusted archive without letting it address unrelated plugins or secrets. */
export function validateConfiguration(input, ctx) {
    const value = object(json(input));
    keys(value, ['qq', 'models', 'references', 'records', 'schedule', 'includesCredentials', 'warnings']);
    if (typeof value.includesCredentials !== 'boolean' || !Array.isArray(value.models) || value.models.length > 32 || !Array.isArray(value.references) || value.references.length > 128 || !Array.isArray(value.records) || value.records.length > 128 || !Array.isArray(value.warnings) || value.warnings.length > 128)
        refusal();
    const qq = object(value.qq);
    if (Object.keys(qq).some(key => !QQ_KEYS.has(key)))
        refusal('迁移包试图修改不属于dsh-feiyu-zeta的配置');
    try {
        ConfigSchema(qq);
    }
    catch {
        refusal('QQ配置不符合当前插件版本');
    }
    const models = value.models.map(item => {
        const row = object(item);
        keys(row, ['id', 'name', 'config']);
        const id = string(row.id, 240);
        const name = string(row.name, 160);
        const config = detached(row.config);
        if (!MODEL_NAMES.has(name) || id === 'im-qqbot' || !/^[\w:.-]+$/u.test(id))
            refusal('迁移包包含不允许的模型配置入口');
        if (name === DEFAULT_MODEL) {
            keys(config, ['provider', 'model', 'reasoningEffort']);
            string(config.provider, 240);
            string(config.model, 240);
            if (config.reasoningEffort !== undefined)
                string(config.reasoningEffort, 120);
        }
        if (name === PI) {
            keys(config, ['providers']);
            for (const [provider, profile] of Object.entries(object(config.providers))) {
                string(provider, 240);
                object(profile);
            }
        }
        return { id, name, config };
    });
    if (new Set(models.map(model => model.id)).size !== models.length)
        refusal('模型配置入口重复');
    const result = { qq: detached(qq), models, references: [], records: [],
        ...(Object.hasOwn(value, 'schedule') ? { schedule: scheduleRetention(value.schedule) } : {}),
        includesCredentials: value.includesCredentials, warnings: value.warnings.map(warning => string(warning, 2000)) };
    const references = allowedReferences(result, ctx);
    result.references = value.references.map(item => { const ref = object(item); keys(ref, ['name', 'value']); const name = string(ref.name, 240); if (!isCredentialRefName(name) || !references.has(name))
        refusal('迁移包包含不属于所选模型的凭据引用'); return { name, value: string(ref.value) }; });
    const records = allowedRecords(result);
    result.records = value.records.map(item => {
        const record = object(item);
        keys(record, ['key', 'record']);
        const key = string(record.key, 300);
        if (!records.has(key))
            refusal('迁移包包含不属于所选模型的凭据记录');
        parseCredentialKey(key);
        const body = object(record.record);
        if (body.kind === 'api-key') {
            keys(body, ['kind', 'key', 'env']);
            if (body.key !== undefined)
                string(body.key);
            if (body.env !== undefined)
                for (const [name, member] of Object.entries(object(body.env))) {
                    if (!isCredentialRefName(name))
                        refusal();
                    string(member);
                }
        }
        else if (body.kind === 'grant') {
            keys(body, ['kind', 'payload']);
            if (!Object.hasOwn(body, 'payload'))
                refusal();
        }
        else
            refusal('迁移包凭据类型无效');
        return { key, record: body };
    });
    if (new Set(result.references.map(ref => ref.name)).size !== result.references.length || new Set(result.records.map(record => record.key)).size !== result.records.length)
        refusal('迁移包凭据地址重复');
    if (!result.includesCredentials && (result.references.length || result.records.length || !isDeepStrictEqual(scrub(result.qq), result.qq) || result.models.some(model => !isDeepStrictEqual(scrub(model.config), model.config))))
        refusal('迁移包声称不含凭据但仍携带敏感内容');
    if (ctx)
        for (const model of result.models) {
            const entry = modelEntry(ctx, model);
            if (!result.includesCredentials) {
                const schema = entry.fiber?.runtime?.Config;
                if (schema && 'toJSON' in schema && !isDeepStrictEqual(redactSecrets(schema, model.config).value, model.config))
                    refusal('不含凭据的迁移包包含模型秘密字段');
            }
        }
    return result;
}
function credentialConflict() { refusal('目标已有不同的模型或语音凭据，请先在DSH设置中处理冲突后再恢复'); }
function credentialReadOnly() { refusal('目标DSH凭据存储目前不可写，请先启用可写凭据存储后再恢复'); }
async function checkReference(ctx, reference, signal) {
    signal.throwIfAborted();
    const ref = credentialRef(reference.name);
    const current = await ctx.credentials.resolve(ref);
    signal.throwIfAborted();
    if (current && current.value !== reference.value)
        credentialConflict();
    if (current)
        return false;
    const info = await ctx.credentials.describe(ref);
    signal.throwIfAborted();
    if (!info.writable)
        credentialReadOnly();
    return true;
}
async function checkRecord(ctx, record, signal) {
    signal.throwIfAborted();
    const key = parseCredentialKey(record.key);
    const current = await ctx.credentials.readRecord(key);
    signal.throwIfAborted();
    if (current && !isDeepStrictEqual(current, record.record))
        credentialConflict();
    if (current)
        return false;
    const info = await ctx.credentials.describeRecord(key);
    signal.throwIfAborted();
    if (!info.writable)
        credentialReadOnly();
    return true;
}
/** Pure admission check for preview: no profile edits, credential writes or restore journal. */
export async function preflightConfiguration(ctx, input, signal) {
    signal.throwIfAborted();
    const value = validateConfiguration(input, ctx);
    for (const model of value.models)
        modelEntry(ctx, model);
    qqEntry(ctx);
    if (value.schedule)
        scheduleEntry(ctx);
    if (!value.includesCredentials)
        return;
    for (const reference of value.references)
        await checkReference(ctx, reference, signal);
    for (const record of value.records)
        await checkRecord(ctx, record, signal);
    signal.throwIfAborted();
}
/** Restore only admitted credentials; existing different values are never intentionally overwritten. */
export async function restoreCredentials(ctx, input, signal) {
    const value = validateConfiguration(input, ctx);
    await preflightConfiguration(ctx, value, signal);
    if (!value.includesCredentials)
        return;
    for (const reference of value.references) {
        if (await checkReference(ctx, reference, signal))
            await ctx.credentials.set(credentialRef(reference.name), reference.value);
    }
    for (const record of value.records) {
        if (!await checkRecord(ctx, record, signal))
            continue;
        await ctx.credentials.modifyRecord(parseCredentialKey(record.key), async (current) => { signal.throwIfAborted(); if (current && !isDeepStrictEqual(current, record.record))
            credentialConflict(); return current ? undefined : structuredClone(record.record); });
    }
    signal.throwIfAborted();
}
/** Final restore commit: ordinary QQ configuration edits may unload this plugin. */
export async function restoreConfiguration(ctx, input, options) {
    const value = validateConfiguration(input, ctx);
    if (!isAbsolute(options.dataDir) || !isAbsolute(options.cwd) || options.connectQQ !== false)
        refusal('恢复目录无效，恢复期间必须保持QQ连接关闭');
    const editor = ctx.configEditor;
    const models = value.models.map(model => ({ model, entry: modelEntry(ctx, model) }));
    const qq = qqEntry(ctx); // Preflight before changing any provider.
    const bridge = value.schedule ? scheduleEntry(ctx) : undefined;
    for (const { model, entry } of models.toSorted((a, b) => Number(a.model.name === DEFAULT_MODEL) - Number(b.model.name === DEFAULT_MODEL)))
        await editor.edit(entry, (current, inherited) => merge(merge(inherited, current), model.config));
    const imported = structuredClone(value.qq);
    for (const field of ['appId', 'appSecret'])
        if (typeof imported[field] !== 'string' || !imported[field] || imported[field] === '__FROM_ENV__' || imported[field].startsWith('process.env'))
            delete imported[field];
    const warnings = [...value.warnings];
    if (Array.isArray(imported.sendFile?.extraRoots) && imported.sendFile.extraRoots.length)
        warnings.push('旧机器的额外文件目录未恢复，请在新机重新选择');
    imported.cwd = options.cwd;
    imported.zeta = { ...imported.zeta, dataDir: options.dataDir, connectQQ: false };
    imported.sendFile = { ...imported.sendFile, extraRoots: [] };
    if (bridge)
        await editor.edit(bridge, (current, inherited) => merge(merge(inherited, current), { ...value.schedule }));
    await editor.edit(qq, (current, inherited) => merge(merge(inherited, current), imported));
    // No access to plugin state or services after the edit's HMR boundary.
    return warnings;
}
/** Explicit owner action after all restore data has committed. */
export async function activateConfiguration(ctx) {
    const editor = ctx.configEditor;
    const entry = qqEntry(ctx);
    await editor.edit(entry, (current, inherited) => {
        const config = merge(inherited, current);
        return { ...config, zeta: { ...config.zeta, connectQQ: true } };
    });
}
//# sourceMappingURL=backup-config.js.map