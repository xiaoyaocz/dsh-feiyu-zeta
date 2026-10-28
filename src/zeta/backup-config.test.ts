import { describe, expect, it, vi } from 'vitest';
import Schema from '@deepseek-ai/schemastery';
import { createVolatile } from '@deepseek-ai/cosmokit';
import type { Context } from '@deepseek-ai/cordis';
import type { Entry } from '@deepseek-ai/cordis-plugin-loader';
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials';
import { activateConfiguration, exportConfiguration, preflightConfiguration, restoreConfiguration, restoreCredentials, validateConfiguration, type PortableConfiguration } from './backup-config.ts';

const DEFAULT = '@deepseek-ai/dsh-agent-default-model';
const PI = '@deepseek-ai/dsh-llm-pi-ai';
const DEEPSEEK = '@deepseek-ai/dsh-llm-deepseek-api-key';
const qq = { appId: 'bot-app', appSecret: 'source-qq-secret', cwd: '/old/workspace', zeta: { dataDir: '/old/data', connectQQ: true }, sendFile: { extraRoots: ['/old/other'] } };
const signal = () => new AbortController().signal;

function fixture() {
  const piSchema = Schema.object({ providers: Schema.dict(Schema.object({ apiKeyEnv: Schema.string(), baseURL: Schema.string(), headers: Schema.dict(Schema.string()), license: Schema.string().role('secret') })) });
  const entry = (id: string, name: string, config: Record<string, unknown>, schema?: unknown) => ({ options: { id, name, config: structuredClone(config) }, id,
    context: {}, fiber: { state: 2, config: structuredClone(config), runtime: { Config: schema } } } as unknown as Entry);
  const entries = [entry('agent-default-model', DEFAULT, { provider: 'anthropic', model: 'sonnet' }),
    entry('llm-pi-ai', PI, { providers: { anthropic: { apiKeyEnv: 'MY_ANTHROPIC_KEY', baseURL: 'https://models.example', headers: { authorization: 'inline-secret' }, license: 'schema-secret' }, unrelated: { apiKeyEnv: 'UNRELATED_KEY', headers: { authorization: 'unrelated-secret' } } } }, piSchema),
    entry('llm-deepseek', DEEPSEEK, { apiKeyEnv: 'DEEPSEEK_API_KEY' }), entry('im-qqbot', 'dsh-zeta', qq),
    entry('unrelated-plugin', 'third-party-plugin', { password: 'do-not-export' })];
  const refs = new Map<string, string>([['ZETA_MIMO_API_KEY', 'mimo-secret'], ['ZETA_MINIMAX_API_KEY', 'minimax-secret'], ['MY_ANTHROPIC_KEY', 'anthropic-secret'], ['ANTHROPIC_API_KEY', 'native-secret'], ['UNRELATED_KEY', 'do-not-read']]);
  const records = new Map<string, CredentialRecord>([['llm-pi-ai/anthropic', { kind: 'api-key', key: 'stored-anthropic' }], ['unrelated-plugin/account', { kind: 'grant', payload: { token: 'do-not-read' } }]]);
  const edits: string[] = [];
  const credentials = {
    resolve: vi.fn(async (name: string) => refs.has(name) ? { value: refs.get(name)!, source: 'file' } : undefined),
    describe: vi.fn(async (name: string) => ({ configured: refs.has(name), writable: true })),
    set: vi.fn(async (name: string, value: string) => { refs.set(name, value); }),
    readRecord: vi.fn(async (key: string) => records.get(key)),
    describeRecord: vi.fn(async (key: string) => ({ configured: records.has(key), writable: true })),
    modifyRecord: vi.fn(async (key: string, mutate: (record: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) => { const next = await mutate(records.get(key)); if (next) records.set(key, next); return records.get(key); }),
  };
  const directory = [{ provider: 'anthropic', displayName: 'Anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], nativeAuth: { env: ['ANTHROPIC_API_KEY'], oauth: true } },
    { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], nativeAuth: { env: ['DEEPSEEK_API_KEY'], oauth: false } }];
  const configEditor = {
    entries: () => entries,
    configuration: () => entries.map(item => ({ entry: item, inherited: {}, override: item.options.config })),
    edit: vi.fn(async (item: Entry, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>) => {
      const next = change(structuredClone(item.options.config ?? {}), {});
      item.options.config = next; item.fiber!.config = next; edits.push(item.options.id);
    }),
  };
  const ctx = { credentials, configEditor, llm: { listConfigurableProviders: () => directory },
    get: (name: string) => name === 'agentDefaultModel' ? { currentSelection: () => entries[0]!.fiber!.config } : undefined } as unknown as Context;
  return { ctx, entries, refs, records, credentials, configEditor, edits, entry };
}
const empty = (): PortableConfiguration => ({ qq: {}, models: [], references: [], records: [], includesCredentials: false, warnings: [] });

function withSchedule(host: ReturnType<typeof fixture>, native = { deliveryHistoryDays: 7, deliveryHistoryRecords: 17 }, bridge: Record<string, unknown> = {}) {
  const original = host.entry('schedule', '@deepseek-ai/dsh-schedule', native);
  original.options.disabled = true; original.fiber = undefined;
  const wrapper = host.entry('zeta-schedule-bridge', 'dsh-zeta/schedule-bridge', bridge);
  // The active wrapper's parsed defaults differ from its explicit raw config.
  wrapper.fiber!.config = { deliveryHistoryDays: 30, deliveryHistoryRecords: 200, ...bridge };
  host.entries.push(original, wrapper);
  return wrapper;
}

describe('portable configuration export uses selected native owners only', () => {
  it('exports effective schedule retention instead of the active wrapper default values', async () => {
    const host = fixture(); withSchedule(host);
    const value = await exportConfiguration(host.ctx, qq, false, signal());
    expect(value.schedule).toEqual({ deliveryHistoryDays: 7, deliveryHistoryRecords: 17 });
    expect(validateConfiguration(JSON.parse(JSON.stringify(value)), host.ctx).schedule).toEqual(value.schedule);
    expect(host.configEditor.edit).not.toHaveBeenCalled();
  });
  it('exports explicit wrapper retention before the old native setting', async () => {
    const host = fixture(); withSchedule(host, undefined, { deliveryHistoryDays: 60 });
    const value = await exportConfiguration(host.ctx, qq, false, signal());
    expect(value.schedule).toEqual({ deliveryHistoryDays: 60, deliveryHistoryRecords: 17 });
  });
  it('exports the active default, used provider subset and admitted secrets without unrelated values', async () => {
    const host = fixture();
    const result = await exportConfiguration(host.ctx, qq, true, signal());
    expect(result.models.map(model => model.name)).toEqual([DEFAULT, PI]);
    expect((result.models[1]!.config.providers as Record<string, unknown>).unrelated).toBeUndefined();
    expect(result.qq.appSecret).toBe('source-qq-secret');
    expect(result.references.map(ref => ref.name)).toEqual(['ZETA_MIMO_API_KEY', 'ZETA_MINIMAX_API_KEY', 'MY_ANTHROPIC_KEY', 'ANTHROPIC_API_KEY']);
    expect(result.records.map(record => record.key)).toEqual(['llm-pi-ai/anthropic']);
    expect(host.credentials.resolve).not.toHaveBeenCalledWith('UNRELATED_KEY');
    expect(JSON.stringify(result)).not.toContain('unrelated-secret');
    expect(JSON.stringify(result)).not.toContain('do-not-export');
  });
  it('removes QQ secrets, schema secrets and all headers while never reading credentials when excluded', async () => {
    const host = fixture();
    const result = await exportConfiguration(host.ctx, qq, false, signal());
    expect(result.qq.appSecret).toBeUndefined();
    const profile = (result.models[1]!.config.providers as Record<string, Record<string, unknown>>).anthropic!;
    expect(profile.apiKeyEnv).toBe('MY_ANTHROPIC_KEY');
    expect(profile.headers).toBeUndefined(); expect(profile.license).toBeUndefined();
    expect(result.references).toEqual([]); expect(result.records).toEqual([]);
    expect(host.credentials.resolve).not.toHaveBeenCalled(); expect(host.credentials.readRecord).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('source-qq-secret');
    expect(JSON.stringify(result)).not.toContain('inline-secret');
    expect(JSON.stringify(result)).not.toContain('schema-secret');
  });
  it('adds only explicitly requested extra first-party routes and honors cancellation', async () => {
    const host = fixture();
    const result = await exportConfiguration(host.ctx, qq, false, signal(), ['deepseek-official']);
    expect(result.models.map(model => model.name)).toContain(DEEPSEEK);
    const controller = new AbortController(); controller.abort();
    await expect(exportConfiguration(host.ctx, qq, true, controller.signal)).rejects.toThrow();
    expect(host.credentials.resolve).not.toHaveBeenCalled();
  });
  it('preserves exact account record types but warns that grants may need new login', async () => {
    const host = fixture();
    const source = host.entries[0]!; source.fiber!.config = { provider: 'deepseek-account', model: 'deepseek' };
    for (const [id, name] of [['llm-account', '@deepseek-ai/dsh-llm-deepseek-account'], ['account', '@deepseek-ai/dsh-deepseek-account-platform']]) host.entries.push({ id, options: { id, name, config: {} }, fiber: { config: {}, runtime: {} } } as Entry);
    host.records.set('deepseek-account-platform/default', { kind: 'grant', payload: { version: 1, issuer: 'https://account.example', token: 'fake-test-token' } });
    host.records.set('deepseek-account-platform/device', { kind: 'grant', payload: { id: 'fake-test-device' } });
    const result = await exportConfiguration(host.ctx, qq, true, signal());
    expect(result.records.map(record => record.key)).toEqual(['deepseek-account-platform/default', 'deepseek-account-platform/device']);
    expect(result.warnings.join('')).toContain('重新登录');
  });
  it('handles a not-yet-configured default model without inventing a route', async () => {
    const host = fixture(); host.entries[0]!.fiber!.config = { provider: '', model: '' };
    const result = await exportConfiguration(host.ctx, qq, false, signal());
    expect(result.models).toEqual([]); expect(result.warnings.join('')).toContain('尚未选择默认模型');
  });
  it.each([true, false])('samples native optional volatile fields before omitting absent object members (credentials: %s)', async includeCredentials => {
    const host = fixture();
    // This is the native rc.3 agent-default-model Config shape: an absent
    // optional field is still a reference, whose get() returns undefined.
    host.entries[0]!.fiber!.config = Schema.object({
      provider: Schema.string().required().volatile(), model: Schema.string().required().volatile(),
      reasoningEffort: Schema.string().volatile(),
    })({ provider: 'anthropic', model: 'sonnet' });
    const profile = Object.assign(Object.create(null), {
      apiKeyEnv: createVolatile('MY_ANTHROPIC_KEY'), baseURL: createVolatile('https://models.example'),
      optional: createVolatile(undefined), nested: { absent: undefined, present: 'kept' },
    });
    host.entries[1]!.fiber!.config = { providers: { anthropic: profile }, optional: createVolatile(undefined) };
    const result = await exportConfiguration(host.ctx, { ...qq, vision: undefined }, includeCredentials, signal());
    expect(result.models[0]!.config).toEqual({ provider: 'anthropic', model: 'sonnet' });
    expect(result.models[1]!.config).toEqual({ providers: { anthropic: {
      apiKeyEnv: 'MY_ANTHROPIC_KEY', baseURL: 'https://models.example', nested: { present: 'kept' },
    } } });
    expect(Object.hasOwn(result.qq, 'vision')).toBe(false);
    expect(() => validateConfiguration(JSON.parse(JSON.stringify(result)), host.ctx)).not.toThrow();
  });
  it.each([
    ['function', () => 'invalid'], ['BigInt', 1n], ['symbol', Symbol('invalid')],
    ['Date', new Date(0)], ['Map', new Map([['key', 'value']])], ['class instance', new class { value = 'not plain'; }()],
    ['undefined array element', [undefined]], ['sparse array', new Array(1)], ['volatile BigInt', createVolatile(1n)],
  ])('refuses invalid native %s without silently dropping it', async (_kind, invalid) => {
    const host = fixture();
    const providers = host.entries[1]!.fiber!.config.providers as Record<string, Record<string, unknown>>;
    providers.anthropic!.invalid = invalid;
    await expect(exportConfiguration(host.ctx, qq, true, signal())).rejects.toThrow();
    expect(host.credentials.resolve).not.toHaveBeenCalled();
  });
});

describe('untrusted migration configuration validation', () => {
  it.each([
    { deliveryHistoryDays: 0, deliveryHistoryRecords: 17 }, { deliveryHistoryDays: 3651, deliveryHistoryRecords: 17 },
    { deliveryHistoryDays: 7, deliveryHistoryRecords: 10001 }, { deliveryHistoryDays: 7, deliveryHistoryRecords: 1.5 },
    { deliveryHistoryDays: '7', deliveryHistoryRecords: 17 }, { deliveryHistoryDays: 7 },
    { deliveryHistoryDays: 7, deliveryHistoryRecords: 17, arbitrary: true },
  ])('rejects invalid or unrelated schedule retention fields (%j)', schedule => {
    expect(() => validateConfiguration({ ...empty(), schedule })).toThrow();
  });
  it('keeps archive validation strict instead of normalizing undefined or volatile members', () => {
    for (const model of [undefined, createVolatile('not-an-archive-value')]) {
      const value = empty(); value.qq.model = model;
      expect(() => validateConfiguration(value)).toThrow();
    }
  });
  it('rejects prototype fields, executable configuration expressions and foreign plugins', () => {
    for (const field of ['__proto__', 'prototype', 'constructor', '__jsExpr']) {
      const value = JSON.parse(JSON.stringify(empty()).replace('"qq":{}', `"qq":{"${field}":{}}`));
      expect(() => validateConfiguration(value)).toThrow('不允许');
    }
    const value = empty(); value.models = [{ id: 'shell', name: 'third-party-shell', config: {} }];
    expect(() => validateConfiguration(value)).toThrow('不允许');
  });
  it('refuses unrelated refs/records and duplicate credential addresses', () => {
    const value = empty(); value.includesCredentials = true;
    value.references = [{ name: 'UNRELATED_KEY', value: 'x' }];
    expect(() => validateConfiguration(value)).toThrow('不属于');
    value.references = []; value.records = [{ key: 'another-plugin/default', record: { kind: 'api-key', key: 'x' } }];
    expect(() => validateConfiguration(value)).toThrow('不属于');
    value.records = []; value.references = [{ name: 'ZETA_MIMO_API_KEY', value: 'x' }, { name: 'ZETA_MIMO_API_KEY', value: 'x' }];
    expect(() => validateConfiguration(value)).toThrow('重复');
  });
  it('requires a native owner directory to admit implicit provider environment refs', async () => {
    const host = fixture(); const value = await exportConfiguration(host.ctx, qq, true, signal());
    expect(() => validateConfiguration(value)).toThrow('不属于');
    expect(validateConfiguration(value, host.ctx)).toEqual(value);
  });
  it('refuses a false no-credentials claim and missing required native provider components', async () => {
    const value = empty(); value.qq.appSecret = 'hidden';
    expect(() => validateConfiguration(value)).toThrow('敏感');
    const host = fixture(); const exported = await exportConfiguration(host.ctx, qq, false, signal());
    host.entries.splice(1, 1);
    expect(() => validateConfiguration(exported, host.ctx)).toThrow('缺少');
  });
  it('checks native schema secrets on import even when their names do not look sensitive', async () => {
    const host = fixture(); const value = await exportConfiguration(host.ctx, qq, false, signal());
    const profile = (value.models.find(model => model.name === PI)!.config.providers as Record<string, Record<string, unknown>>).anthropic!;
    profile.license = 'secret-in-archive';
    expect(() => validateConfiguration(value, host.ctx)).toThrow('秘密字段');
  });
});

describe('public credential and configuration restore', () => {
  it('requires an active configurable schedule bridge during preview without performing any writes', async () => {
    const host = fixture(); const value = { ...empty(), schedule: { deliveryHistoryDays: 7, deliveryHistoryRecords: 17 } };
    await expect(preflightConfiguration(host.ctx, value, signal())).rejects.toThrow('自动任务迁移组件');
    const bridge = withSchedule(host); bridge.fiber!.state = 0;
    await expect(preflightConfiguration(host.ctx, value, signal())).rejects.toThrow('自动任务迁移组件');
    bridge.fiber!.state = 2;
    await preflightConfiguration(host.ctx, value, signal());
    expect(host.configEditor.edit).not.toHaveBeenCalled();
    expect(host.credentials.set).not.toHaveBeenCalled(); expect(host.credentials.modifyRecord).not.toHaveBeenCalled();
  });
  it('restores retention before the final QQ edit and uses captured configuration services across schedule HMR', async () => {
    const source = fixture(); withSchedule(source);
    const value = await exportConfiguration(source.ctx, qq, false, signal());
    const host = fixture(); const bridge = withSchedule(host, { deliveryHistoryDays: 9, deliveryHistoryRecords: 19 });
    const originalEdit = host.configEditor.edit.getMockImplementation()!;
    host.configEditor.edit.mockImplementation(async (entry, change) => {
      await originalEdit(entry, change);
      if (entry === bridge) Object.defineProperty(host.ctx, 'configEditor', { get: () => { throw new Error('source context disposed by schedule HMR'); } });
    });
    await restoreConfiguration(host.ctx, value, { dataDir: '/new/data', cwd: '/new/workspaces', connectQQ: false });
    expect(host.edits).toEqual(['llm-pi-ai', 'agent-default-model', 'zeta-schedule-bridge', 'im-qqbot']);
    expect(bridge.options.config).toEqual({ deliveryHistoryDays: 7, deliveryHistoryRecords: 17 });
    expect(host.entries.find(entry => entry.options.id === 'im-qqbot')!.options.config.zeta.connectQQ).toBe(false);
  });
  it('does not apply native defaults over target retention when an older backup omits schedule configuration', async () => {
    const host = fixture(); const bridge = withSchedule(host, { deliveryHistoryDays: 9, deliveryHistoryRecords: 19 }, { deliveryHistoryDays: 60 });
    await restoreConfiguration(host.ctx, empty(), { dataDir: '/new/data', cwd: '/new/workspaces', connectQQ: false });
    expect(host.edits).toEqual(['im-qqbot']);
    expect(bridge.options.config).toEqual({ deliveryHistoryDays: 60 });
  });
  it('preflights existing model and QQ entries plus missing writable credentials without any mutations', async () => {
    const host = fixture(); const value = await exportConfiguration(host.ctx, qq, true, signal());
    host.refs.delete('ZETA_MIMO_API_KEY'); host.records.delete('llm-pi-ai/anthropic');
    const beforeRefs = [...host.refs.entries()]; const beforeRecords = [...host.records.entries()];
    await preflightConfiguration(host.ctx, value, signal());
    expect(host.credentials.describe).toHaveBeenCalledWith('ZETA_MIMO_API_KEY');
    expect(host.credentials.describeRecord).toHaveBeenCalledWith('llm-pi-ai/anthropic');
    expect(host.credentials.set).not.toHaveBeenCalled(); expect(host.credentials.modifyRecord).not.toHaveBeenCalled();
    expect(host.configEditor.edit).not.toHaveBeenCalled();
    expect([...host.refs.entries()]).toEqual(beforeRefs); expect([...host.records.entries()]).toEqual(beforeRecords);
  });
  it('refuses read-only destinations during preview and still performs no writes', async () => {
    const host = fixture(); const value = await exportConfiguration(host.ctx, qq, true, signal());
    host.refs.delete('ZETA_MIMO_API_KEY');
    host.credentials.describe.mockResolvedValue({ configured: false, writable: false });
    await expect(preflightConfiguration(host.ctx, value, signal())).rejects.toThrow('不可写');
    host.refs.set('ZETA_MIMO_API_KEY', 'mimo-secret'); host.records.delete('llm-pi-ai/anthropic');
    host.credentials.describeRecord.mockResolvedValue({ configured: false, writable: false });
    await expect(preflightConfiguration(host.ctx, value, signal())).rejects.toThrow('不可写');
    expect(host.credentials.set).not.toHaveBeenCalled(); expect(host.credentials.modifyRecord).not.toHaveBeenCalled();
    expect(host.configEditor.edit).not.toHaveBeenCalled();
  });
  it('preflights all credential conflicts before writing and never includes values in the error', async () => {
    const host = fixture(); const value = await exportConfiguration(host.ctx, qq, true, signal());
    host.refs.delete('ZETA_MIMO_API_KEY'); host.refs.set('ZETA_MINIMAX_API_KEY', 'target-secret');
    await expect(restoreCredentials(host.ctx, value, signal())).rejects.toThrow('目标已有不同');
    try { await restoreCredentials(host.ctx, value, signal()); } catch (error) { expect(String(error)).not.toContain('target-secret'); expect(String(error)).not.toContain('minimax-secret'); }
    expect(host.credentials.set).not.toHaveBeenCalled(); expect(host.credentials.modifyRecord).not.toHaveBeenCalled();
  });
  it('imports absent refs and records through native operations and reuses equal credentials', async () => {
    const host = fixture(); const value = await exportConfiguration(host.ctx, qq, true, signal());
    host.refs.delete('ZETA_MIMO_API_KEY'); host.records.delete('llm-pi-ai/anthropic');
    await restoreCredentials(host.ctx, value, signal());
    expect(host.credentials.set).toHaveBeenCalledExactlyOnceWith('ZETA_MIMO_API_KEY', 'mimo-secret');
    expect(host.records.get('llm-pi-ai/anthropic')).toEqual({ kind: 'api-key', key: 'stored-anthropic' });
    expect(host.credentials.modifyRecord).toHaveBeenCalledTimes(1);
  });
  it('detects a changed record inside the native atomic modify callback', async () => {
    const host = fixture(); const value = await exportConfiguration(host.ctx, qq, true, signal());
    host.records.delete('llm-pi-ai/anthropic');
    host.credentials.modifyRecord.mockImplementationOnce(async (_key, mutate) => mutate({ kind: 'api-key', key: 'concurrent-change' }));
    await expect(restoreCredentials(host.ctx, value, signal())).rejects.toThrow('目标已有不同');
    expect(host.records.get('llm-pi-ai/anthropic')).toBeUndefined();
  });
  it('restores providers before selection and QQ last, relocates paths and preserves target secrets', async () => {
    const host = fixture(); const value = await exportConfiguration(host.ctx, qq, false, signal());
    const qqRow = host.entries.find(row => row.options.id === 'im-qqbot')!;
    qqRow.options.config.appSecret = 'target-qq-secret';
    const piRow = host.entries.find(row => row.options.id === 'llm-pi-ai')!;
    piRow.options.config.providers.anthropic.license = 'target-license';
    const warnings = await restoreConfiguration(host.ctx, value, { dataDir: '/new/data', cwd: '/new/workspace', connectQQ: false });
    expect(host.edits).toEqual(['llm-pi-ai', 'agent-default-model', 'im-qqbot']);
    expect(qqRow.options.config).toMatchObject({ appSecret: 'target-qq-secret', cwd: '/new/workspace', zeta: { dataDir: '/new/data', connectQQ: false }, sendFile: { extraRoots: [] } });
    expect(piRow.options.config.providers.anthropic.license).toBe('target-license');
    expect(piRow.options.config.providers.unrelated).toBeDefined();
    expect(warnings.join('')).toContain('额外文件目录未恢复');
    expect(host.credentials.set).not.toHaveBeenCalled();
  });
  it('does not install empty environment placeholders and uses an explicit final activation edit', async () => {
    const host = fixture(); const value = empty(); value.qq = { appId: '__FROM_ENV__' };
    await restoreConfiguration(host.ctx, value, { dataDir: '/new/data', cwd: '/new/workspace', connectQQ: false });
    const qqRow = host.entries.find(row => row.options.id === 'im-qqbot')!;
    expect(qqRow.options.config.appId).toBe('bot-app');
    expect(qqRow.options.config.zeta.connectQQ).toBe(false);
    await activateConfiguration(host.ctx);
    expect(qqRow.options.config.zeta.connectQQ).toBe(true);
  });
  it('rejects invalid destinations or absent QQ entry before changing native providers', async () => {
    const host = fixture(); const value = await exportConfiguration(host.ctx, qq, false, signal());
    await expect(restoreConfiguration(host.ctx, value, { dataDir: 'relative', cwd: '/workspace', connectQQ: false })).rejects.toThrow('目录无效');
    host.entries.splice(host.entries.findIndex(entry => entry.options.id === 'im-qqbot'), 1);
    await expect(restoreConfiguration(host.ctx, value, { dataDir: '/new/data', cwd: '/new/workspace', connectQQ: false })).rejects.toThrow('未安装');
    expect(host.edits).toEqual([]);
  });
});
