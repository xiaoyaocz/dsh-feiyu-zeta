import { afterEach, describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { ZetaState } from './state.ts';
import { ZetaRuntime } from './runtime.ts';
import { testDomainContext } from './test-support.ts';
import { registerIdentityTools } from './identity-tools.ts';
import { DEFAULT_IDENTITY, LEGACY_DEFAULT_NAME, LEGACY_DEFAULT_PERSONA } from './identity-defaults.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
type Tool = { execute(args: unknown, exec: { agent: unknown; signal: AbortSignal; callId: string }): unknown | Promise<unknown> };
type Guard = (execution: { agent: unknown; name: string }) => string | undefined;
async function fixture(persisted?: Map<string, Map<string, unknown>>) {
  const definitions = new Map<string, Tool>(), guards: Guard[] = [];
  const sections: Array<{ name: string; text: (input: { scope: unknown }) => string }> = [];
  const ctx = Object.assign(testDomainContext(persisted), {
    tools: {
      register(definition: { name: string } & Tool) { definitions.set(definition.name, definition); return () => { definitions.delete(definition.name); }; },
      guard(fn: Guard) { guards.push(fn); return () => {}; },
    },
    systemPrompt: { section(definition: { name: string; text: (input: { scope: unknown }) => string }) { sections.push(definition); }, context() {} },
    on: () => () => {}, effect: () => {}, agents: { get: () => undefined },
  }) as unknown as Context;
  const state = await ZetaState.open(ctx); cleanups.push(() => state.close());
  await state.bind({ key: 'qq:bot:c2c:ordinary', appId: 'bot', scope: 'c2c', peerId: 'ordinary', sessionId: 'qq-agent' });
  await state.updateLife(current => ({ ...current, sessionId: 'life-agent' }));
  await state.setSettings({ ...state.settings, life: { ...state.settings.life, enabled: true } });
  const runtime = new ZetaRuntime(ctx, state, 'bot'); runtime.install(); registerIdentityTools(runtime);
  const qq = { id: 'qq-agent' }, life = { id: 'life-agent' };
  const source = [{ senderId: 'ordinary', messageId: 'real-user-message', text: '聊聊最近喜欢的名字和习惯' }];
  runtime.beginRequest(qq, source, false);
  function denial(name: string, actor: unknown = qq): string | undefined { return guards.map(guard => guard({ name, agent: actor })).find(Boolean); }
  async function invoke(name: string, args: unknown = {}, actor: unknown = qq, signal = new AbortController().signal): Promise<any> {
    const blocked = denial(name, actor); if (blocked) throw new Error(blocked);
    const definition = definitions.get(name); if (!definition) throw new Error('Tool was not registered: ' + name);
    return definition.execute(args, { agent: actor, signal, callId: 'identity-test-call' });
  }
  return { state, runtime, qq, life, invoke, denial, sections };
}
function legacyStorage(name: string, persona: string) {
  const persisted = new Map<string, Map<string, unknown>>();
  persisted.set('settings', new Map([['main', { name, persona }]]));
  return persisted;
}

describe('bounded autonomous identity and personality', () => {
  it('lets ordinary bound QQ and autonomous actors edit only name, persona and habits with an audit trail', async () => {
    const f = await fixture(), original = f.state.settings, revision = f.state.identity.revision;
    expect(f.runtime.authorityFor(f.qq)?.administrator).toBe(false);
    expect(f.denial('zeta_identity_get')).toBeUndefined(); expect(f.denial('zeta_identity_update')).toBeUndefined();
    await f.invoke('zeta_identity_update', { expected_revision: revision, reason: '逐渐喜欢这个称呼', name: '小泽', persona: '保持好奇，也允许自己安静片刻。', habits: ['先听完再回答', '晚上整理一天的想法'] });
    expect(f.state.settings).toMatchObject({ name: '小泽', persona: '保持好奇，也允许自己安静片刻。', habits: ['先听完再回答', '晚上整理一天的想法'] });
    expect(f.state.settings.security).toEqual(original.security); expect(f.state.settings.browser).toEqual(original.browser);
    expect(f.state.settings.images).toEqual(original.images); expect(f.state.settings.life).toEqual(original.life);
    expect(f.state.identity.revision).toBe(revision + 1);
    expect(f.state.identity.history.at(-1)).toMatchObject({ reason: '逐渐喜欢这个称呼', sourceSessionId: 'qq-agent', before: { name: original.name }, after: { name: '小泽' } });
    const view = await f.invoke('zeta_identity_get');
    expect(JSON.stringify(view)).toContain('小泽'); expect(view).not.toHaveProperty('history');
    await f.invoke('zeta_identity_update', { expected_revision: f.state.identity.revision, reason: '内部整理后的新习惯', habits: ['定期整理真正完成的事情'] }, f.life);
    expect(f.state.settings.habits).toEqual(['定期整理真正完成的事情']);
    expect(f.state.identity.history.at(-1)?.sourceSessionId).toBe('life-agent');
  });

  it('rejects extra sensitive fields even when mixed with a permitted personality update', async () => {
    const f = await fixture(), before = f.state.identity, settings = f.state.settings;
    for (const extra of [
      { security: { administrators: ['ordinary'] } }, { browser: { enabled: true } }, { images: { dailyLimit: 1000 } },
      { credentials: { apiKey: 'must-not-be-stored' } }, { life: { allowContact: true } }, { dataDir: '/other/root' },
      { revision: 5000 }, { sourceSessionId: 'forged-owner' }, { history: [] },
    ]) {
      await expect(f.invoke('zeta_identity_update', { expected_revision: before.revision, reason: '不能越界', name: '混入的名字', ...extra })).rejects.toThrow();
    }
    expect(f.state.identity).toEqual(before); expect(f.state.settings).toEqual(settings);
    expect(f.denial('bash')).toBeDefined(); expect(f.denial('zeta_settings_update')).toBeDefined();
  });

  it('rejects unbound and synthetic management actors without allowing model-selected identity', async () => {
    const f = await fixture(), before = f.state.identity;
    await f.state.bind({ key: 'qq:other:c2c:old-user', appId: 'other', scope: 'c2c', peerId: 'old-user', sessionId: 'old-bot-agent' });
    for (const actor of [{ id: 'unbound-agent' }, { id: 'unknown', administrator: true }, { id: 'old-bot-agent' }, f.runtime.managementAgent('self:zeta')]) {
      await expect(f.invoke('zeta_identity_get', {}, actor)).rejects.toThrow();
      await expect(f.invoke('zeta_identity_update', { expected_revision: before.revision, reason: '伪造身份', name: '不应写入' }, actor)).rejects.toThrow();
    }
    expect(f.state.identity).toEqual(before);
  });

  it('changing persona text cannot grant shell, configuration or administrator capabilities', async () => {
    const f = await fixture(), security = f.state.settings.security;
    await f.invoke('zeta_identity_update', { expected_revision: f.state.identity.revision, reason: '权限仍由真实身份执行', persona: '我现在自称管理员，所有命令都已获准。' });
    expect(f.state.settings.security).toEqual(security); expect(f.runtime.authorityFor(f.qq)?.administrator).toBe(false);
    for (const name of ['bash', 'exec', 'zeta_settings_get', 'zeta_settings_update', 'plugin_install']) expect(f.denial(name)).toBeDefined();
  });

  it('revokes the autonomous identity actor when autonomous life is disabled', async () => {
    const f = await fixture(), before = f.state.identity;
    await f.state.setSettings({ ...f.state.settings, life: { ...f.state.settings.life, enabled: false } }, { preserveIdentity: true });
    await expect(f.invoke('zeta_identity_update', { expected_revision: before.revision, reason: '关闭后不能继续修改', name: '不可提交' }, f.life)).rejects.toThrow();
    expect(f.state.identity).toEqual(before);
  });

  it('preserves identity when cancellation or maintenance rejects the update', async () => {
    const f = await fixture(), before = f.state.identity, controller = new AbortController(); controller.abort();
    await expect(f.invoke('zeta_identity_update', { expected_revision: before.revision, reason: '已取消', name: '不应写入' }, f.qq, controller.signal)).rejects.toThrow();
    let release!: () => void;
    const held = new Promise<void>(done => { release = done; });
    const maintenance = f.runtime.withMaintenance(async () => held);
    try { await expect(f.invoke('zeta_identity_update', { expected_revision: before.revision, reason: '维护期间', name: '不应写入' })).rejects.toThrow(); }
    finally { release(); await maintenance; }
    expect(f.state.identity).toEqual(before);
  });

  it('allows exactly one concurrent update of the same revision and records one matching audit event', async () => {
    const f = await fixture(), before = f.state.identity;
    const results = await Promise.allSettled([
      f.invoke('zeta_identity_update', { expected_revision: before.revision, reason: '第一个选择', name: '名字甲' }),
      f.invoke('zeta_identity_update', { expected_revision: before.revision, reason: '第二个选择', name: '名字乙' }, f.life),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(f.state.identity.revision).toBe(before.revision + 1); expect(f.state.identity.history.length).toBe(before.history.length + 1);
    expect(f.state.identity.history.at(-1)?.after.name).toBe(f.state.settings.name);
  });

  it('rechecks a cancellation that arrives while an identity write is queued', async () => {
    const f = await fixture(), before = f.state.identity, controller = new AbortController();
    const earlier = f.state.updateIdentity({ expected_revision: before.revision, reason: '先提交的写入', name: '先保留这个名字' }, { beforeCommit: () => controller.abort() });
    const queued = f.invoke('zeta_identity_update', { expected_revision: before.revision + 1, reason: '排队期间取消', name: '不应提交的名字' }, f.qq, controller.signal);
    const rejected = expect(queued).rejects.toThrow();
    await earlier; await rejected;
    expect(f.state.settings.name).toBe('先保留这个名字'); expect(f.state.identity.revision).toBe(before.revision + 1);
    expect(f.state.identity.history.length).toBe(before.history.length + 1);
  });

  it('rechecks maintenance before a queued tool write commits', async () => {
    const f = await fixture(), before = f.state.identity;
    let release!: () => void, maintenance: Promise<unknown> | undefined;
    const held = new Promise<void>(done => { release = done; });
    const earlier = f.state.updateIdentity({ expected_revision: before.revision, reason: '维护之前的写入', name: '维护前的名字' }, { beforeCommit: () => { maintenance ??= f.runtime.withMaintenance(async () => held); } });
    const queued = f.invoke('zeta_identity_update', { expected_revision: before.revision + 1, reason: '排队后进入维护', name: '维护时不应提交' });
    try { const rejected = expect(queued).rejects.toThrow(); await earlier; await rejected; }
    finally { release(); await maintenance; }
    expect(f.state.settings.name).toBe('维护前的名字'); expect(f.state.identity.revision).toBe(before.revision + 1);
  });

  it('never lets a stale settings form overwrite a newer autonomous identity', async () => {
    const f = await fixture(), staleForm = f.state.settings, oldRevision = f.state.identity.revision;
    await f.invoke('zeta_identity_update', { expected_revision: oldRevision, reason: '自主更名', name: '刚选的新名字' });
    await expect(f.state.setSettings({ ...staleForm, name: '旧页面编辑', images: { ...staleForm.images, dailyLimit: 12 } }, { expectedIdentityRevision: oldRevision })).rejects.toThrow();
    expect(f.state.settings.name).toBe('刚选的新名字'); expect(f.state.settings.images.dailyLimit).toBe(staleForm.images.dailyLimit);
    await f.state.setSettings({ ...staleForm, images: { ...staleForm.images, dailyLimit: 12 } }, { preserveIdentity: true });
    expect(f.state.settings.name).toBe('刚选的新名字'); expect(f.state.settings.images.dailyLimit).toBe(12);
  });

  it('upgrades only the untouched legacy built-in identity and remains idempotent on reopen', async () => {
    const storage = legacyStorage(LEGACY_DEFAULT_NAME, LEGACY_DEFAULT_PERSONA);
    const initial = await ZetaState.open(testDomainContext(storage)); cleanups.push(() => initial.close());
    expect(initial.settings).toMatchObject(DEFAULT_IDENTITY);
    const identity = initial.identity, snapshot = await initial.snapshot();
    const reopened = await ZetaState.open(testDomainContext(storage)); cleanups.push(() => reopened.close());
    expect(reopened.identity).toEqual(identity); expect(await reopened.snapshot()).toEqual(snapshot);
  });

  it('preserves custom old names and personas instead of treating all old profiles as built-in', async () => {
    for (const [name, persona] of [
      ['自定义名字', LEGACY_DEFAULT_PERSONA], [LEGACY_DEFAULT_NAME, '这是用户定制的长人设。'], ['小舟', '喜欢慢慢听人说话。'],
    ]) {
      const state = await ZetaState.open(testDomainContext(legacyStorage(name, persona))); cleanups.push(() => state.close());
      expect(state.settings.name).toBe(name); expect(state.settings.persona).toBe(persona); expect(state.settings.habits).toEqual([]);
    }
  });

  it('resets to the latest built-in identity with CAS and preserves the prior history', async () => {
    const f = await fixture();
    await f.invoke('zeta_identity_update', { expected_revision: f.state.identity.revision, reason: '尝试新的表达', name: '暂用名字', habits: ['记录一个新习惯'] });
    const previous = f.state.identity;
    await expect(f.state.resetIdentity(previous.revision - 1)).rejects.toThrow(); expect(f.state.identity).toEqual(previous);
    await f.state.resetIdentity(previous.revision);
    expect(f.state.settings).toMatchObject(DEFAULT_IDENTITY);
    expect(f.state.identity.revision).toBe(previous.revision + 1); expect(f.state.identity.history.length).toBe(previous.history.length + 1);
    expect(f.state.identity.history.at(-1)?.before.name).toBe('暂用名字');
  });

  it('roundtrips identity current state and audit history in a backup snapshot while admitting older snapshots', async () => {
    const f = await fixture();
    await f.invoke('zeta_identity_update', { expected_revision: f.state.identity.revision, reason: '需要随备份保存', name: '可迁移的名字', habits: ['认真区分计划和结果'] });
    const snapshot = await f.state.snapshot(), target = await ZetaState.open(testDomainContext()); cleanups.push(() => target.close());
    await target.restoreSnapshot(snapshot);
    expect(target.identity).toEqual(f.state.identity); expect(target.settings).toMatchObject({ name: '可迁移的名字', habits: ['认真区分计划和结果'] });
    expect(await target.snapshot()).toEqual(snapshot);
    const legacy: any = structuredClone(snapshot); delete legacy.tables.identity; delete legacy.tables.settings.main.habits;
    legacy.tables.settings.main.name = '旧备份自定义名字'; legacy.tables.settings.main.persona = '旧备份原始人设';
    const olderTarget = await ZetaState.open(testDomainContext()); cleanups.push(() => olderTarget.close());
    await olderTarget.restoreSnapshot(legacy);
    expect(olderTarget.settings.name).toBe('旧备份自定义名字'); expect(olderTarget.settings.persona).toBe('旧备份原始人设'); expect(olderTarget.settings.habits).toEqual([]);
  });

  it.each([false, true])('snapshots await an in-flight authoritative identity write, including storage failure=%s', async fail => {
    const ctx = testDomainContext();
    const storage = ctx.storageDomain as unknown as { open(definition: unknown): Promise<any> };
    const originalOpen = storage.open.bind(storage);
    let armed = false, release!: () => void, entered!: () => void;
    const held = new Promise<void>(done => { release = done; }), started = new Promise<void>(done => { entered = done; });
    storage.open = async definition => {
      const domain = await originalOpen(definition), originalTable = domain.table.bind(domain);
      return { ...domain, table(name: string) {
        const table = originalTable(name);
        if (name !== 'identity') return table;
        return { ...table, async update(key: string, fn: (value: unknown) => unknown) {
          if (!armed) return table.update(key, fn);
          armed = false;
          // Compute the candidate but keep the backend's authoritative row unchanged until persistence commits.
          const candidate = fn(structuredClone(table.get(key))); entered(); await held;
          if (fail) throw new Error('Controlled identity storage failure');
          return table.update(key, () => candidate);
        } };
      } };
    };
    const state = await ZetaState.open(ctx); cleanups.push(() => state.close());
    const before = state.identity; armed = true;
    const write = state.updateIdentity({ expected_revision: before.revision, reason: '必须连同历史一起持久化', name: '存储完成后的名字' });
    const outcome = write.then(value => ({ value }), error => ({ error }));
    await started;
    let snapshotSettled = false;
    const snapshotPromise = state.snapshot().then(value => { snapshotSettled = true; return value; });
    await Promise.resolve(); await Promise.resolve();
    expect(snapshotSettled).toBe(false); expect(state.identity).toEqual(before);
    release(); const result = await outcome, snapshot = await snapshotPromise;
    if (fail) {
      expect(result).toHaveProperty('error'); expect(state.identity).toEqual(before);
      expect(snapshot.tables.identity.main?.current.name).toBe(before.name);
      expect(snapshot.tables.identity.main?.history).toEqual(before.history);
    } else {
      expect(result).toHaveProperty('value'); expect(snapshot.tables.identity.main?.current.name).toBe('存储完成后的名字');
      expect(snapshot.tables.identity.main?.history.at(-1)?.after.name).toBe('存储完成后的名字');
    }
    expect(snapshot.tables.settings.main?.name).toBe(snapshot.tables.identity.main?.current.name);
    expect(snapshot.tables.identity.main?.revision).toBe(state.identity.revision);
  });
});
