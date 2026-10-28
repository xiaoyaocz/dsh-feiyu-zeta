import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImQQBotConfig } from '../config.ts';
import type { ModelRoute } from '../model/types.ts';
import type { ReplyTarget } from '../types.ts';
import { SessionManager } from './session-manager.ts';
import type { DshAgent, DshAgentRegistry, SessionEventLike } from './types.ts';

const base = realpathSync(tmpdir());
let home: string;
const managers: SessionManager[] = [];
beforeEach(() => { home = mkdtempSync(join(base, 'zeta-shared-session-')); vi.stubEnv('DSH_HOME', home); });
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.disposeAll();
  vi.unstubAllEnvs();
  const path = relative(base, home);
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('Unsafe fixture cleanup');
  rmSync(home, { recursive: true, force: true });
});
const route = (model: string): ModelRoute => ({ provider: 'fixture', model });
const target = (scope: 'c2c' | 'group', id: string): ReplyTarget => ({ scope, targetId: id, msgId: `message-${id}` });
interface Stored { headerPreset?: string; projectedPreset: string | null; lastRoute?: ModelRoute; history: SessionEventLike[] }

function fixture(overrides: Partial<ImQQBotConfig> = {}) {
  const config = { appId: 'bot', provider: 'fixture', model: 'configured', preset: '', sessionIdleTimeout: 0, ...overrides } as ImQQBotConfig;
  const live = new Map<string, DshAgent>(), stored = new Map<string, Stored>();
  const projections = new WeakMap<object, { pending: ModelRoute | null; preset: string | null }>();
  const mounts = new Map<object, string>();
  const services: Record<string, any> = {};
  services.llm = { listProviders: () => ['fixture'], listModels: async () => [...new Set(['configured', 'new-shared', 'next', 'shared-current', config.model])].map(id => ({ id })) };
  const ctx = { get: (name: string) => services[name], on: vi.fn() } as unknown as Context;
  const released = vi.fn();
  services.sessionQuery = { observeSession: vi.fn(async (id: string) => {
    const row = stored.get(id);
    if (!row) throw Object.assign(new Error('Session not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' });
    return { header: { agentPreset: row.headerPreset }, projections: { values: { agentPreset: row.projectedPreset } }, [Symbol.dispose]: released };
  }) };
  services.sessionPersistence = { stat: vi.fn(async (id: string) => { const row = stored.get(id); return row ? { header: { agentPreset: row.headerPreset } } : undefined; }) };
  services.sessionProjections = { stateOf: (session: object, name: string) => {
    const value = projections.get(session);
    return name === 'modelSelection' ? { pending: value?.pending ?? null } : name === 'agentPreset' ? value?.preset : undefined;
  } };
  services.agentPresets = {
    defaultId: 'standard',
    resolve: vi.fn(async (id?: string) => {
      const selected = id ?? 'standard';
      if (!['standard', 'creative', 'recorded'].includes(selected)) throw new Error('Unknown preset');
      return { id: selected };
    }),
    mount: vi.fn(async (agentCtx: object, id: string) => { mounts.set(agentCtx, id); }),
    composedPreset: (agentCtx: object) => mounts.get(agentCtx),
    list: async () => [{ id: 'standard' }, { id: 'creative' }, { id: 'recorded' }],
  };
  async function construct(id: string, options: { agentOptions?: { provider?: string; model?: string }; meta?: { agentPreset?: string }; setup?: (context: Context) => unknown }, previous?: Stored) {
    const agentCtx = {} as Context;
    const history = previous?.history ?? [];
    const session = { id, events: history, header: { agentPreset: previous?.headerPreset ?? options.meta?.agentPreset }, requestHeader: () => previous?.lastRoute ? { config: previous.lastRoute } : undefined };
    const agent = { id, ctx: agentCtx, session, status: 'idle' as const, options: options.agentOptions ?? route('configured'), cancel: vi.fn(), followup: vi.fn(), whenIdle: async () => {}, runMaintenance: async <T>(work: (signal: AbortSignal) => Promise<T>) => work(new AbortController().signal) };
    projections.set(session, { pending: null, preset: previous ? previous.projectedPreset : options.meta?.agentPreset ?? null });
    await options.setup?.(agentCtx); live.set(id, agent);
    return { agent, dispose: vi.fn(async () => { live.delete(id); }) };
  }
  const agents: DshAgentRegistry = {
    get: id => live.get(id),
    resume: vi.fn(async options => {
      const previous = stored.get(options.resumeSessionId);
      if (!previous) throw new Error('Session not found');
      return construct(options.resumeSessionId, options, previous);
    }),
    create: vi.fn(async options => construct(options.sessionId, options)),
  };
  const selectModel = vi.fn(async (request: { sessionId: string; provider: string; model: string }) => {
    const agent = live.get(request.sessionId)!;
    const selected = { provider: request.provider, model: request.model };
    projections.get(agent.session)!.pending = selected;
    (agent.session.events as SessionEventLike[]).push({ type: 'model/selection', data: selected });
    return { selected };
  });
  Object.assign(ctx, { sessionController: { selectModel } });
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const manager = new SessionManager(ctx, agents, config, logger); managers.push(manager);
  return { manager, agents, config, stored, services, released, selectModel, live, projections };
}

describe('shared QQ model admission and native preset history', () => {
  it('changes every chat on its next request without merging Agents, targets or history', async () => {
    const f = fixture(), privateChat = await f.manager.getOrCreate('c2c', 'alice', 'alice', target('c2c', 'alice'));
    const group = await f.manager.getOrCreate('group', 'room', 'bob', target('group', 'room'));
    const original = { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'private history' }] } } };
    (privateChat.agent.session.events as SessionEventLike[]).push(original);
    expect(privateChat.sessionId).not.toBe(group.sessionId);
    await f.manager.setModelOverride('c2c', 'alice', route('new-shared'));
    expect(f.selectModel).not.toHaveBeenCalled();
    expect(f.manager.getStatus('group', 'room')).toMatchObject({ model: 'configured', defaultModel: 'new-shared' });
    const privateAgain = await f.manager.getOrCreate('c2c', 'alice', 'alice', target('c2c', 'alice'));
    const groupAgain = await f.manager.getOrCreate('group', 'room', 'bob', target('group', 'room'));
    expect(privateAgain.agent).toBe(privateChat.agent); expect(groupAgain.agent).toBe(group.agent);
    expect(privateAgain.sessionId).toBe(privateChat.sessionId); expect(groupAgain.sessionId).toBe(group.sessionId);
    expect(privateAgain.replyTarget).toEqual(target('c2c', 'alice')); expect(groupAgain.replyTarget).toEqual(target('group', 'room'));
    expect(privateAgain.agent.session.events).toContain(original); expect(f.selectModel).toHaveBeenCalledTimes(2);
    expect(f.manager.getStatus('group', 'room')).toMatchObject({ model: 'new-shared', defaultModel: 'new-shared' });
    expect(privateChat.agent.cancel).not.toHaveBeenCalled(); expect(group.agent.cancel).not.toHaveBeenCalled();
  });

  it('leaves an ongoing response untouched and reconciles after the Agent becomes idle', async () => {
    const f = fixture(), group = await f.manager.getOrCreate('group', 'room', 'bob', target('group', 'room'));
    Object.assign(group.agent, { status: 'running' }); await f.manager.setModelOverride('c2c', 'alice', route('next'));
    await f.manager.getOrCreate('group', 'room', 'bob', target('group', 'room'));
    expect(f.selectModel).not.toHaveBeenCalled(); expect(group.agent.cancel).not.toHaveBeenCalled();
    expect(f.manager.getStatus('group', 'room')).toMatchObject({ model: 'configured', defaultModel: 'next' });
    Object.assign(group.agent, { status: 'idle' }); await f.manager.getOrCreate('group', 'room', 'bob', target('group', 'room'));
    expect(f.selectModel).toHaveBeenCalledExactlyOnceWith({ sessionId: group.sessionId, ...route('next') });
  });

  it('restores the native preset projection rather than the initial header or the new shared default', async () => {
    const f = fixture({ model: 'shared-current', preset: 'creative' }), id = f.manager.currentSessionIdFor('group', 'room');
    const history = [{ type: 'turn/start' }, { type: 'agent-preset/selected', data: { agentPreset: 'recorded' } }];
    f.stored.set(id, { headerPreset: 'standard', projectedPreset: 'recorded', lastRoute: route('old-model'), history });
    const record = await f.manager.getOrCreate('group', 'room', 'bob', target('group', 'room'));
    expect(record.sessionId).toBe(id); expect(record.agent.session.events?.slice(0, 2)).toEqual(history.slice(0, 2));
    expect(f.agents.create).not.toHaveBeenCalled(); expect(f.services.agentPresets.mount).toHaveBeenCalledWith(record.agent.ctx, 'recorded');
    expect(f.released).toHaveBeenCalledTimes(1);
    expect(f.selectModel).toHaveBeenCalledExactlyOnceWith({ sessionId: id, ...route('shared-current') });
    expect(f.manager.getStatus('group', 'room')).toMatchObject({ preset: 'recorded', defaultPreset: 'creative', model: 'shared-current' });
  });

  it('does not add a preset to an existing no-preset log', async () => {
    const f = fixture({ preset: 'creative' }), id = f.manager.currentSessionIdFor('c2c', 'alice');
    f.stored.set(id, { projectedPreset: null, lastRoute: route('configured'), history: [{ type: 'turn/start' }] });
    const record = await f.manager.getOrCreate('c2c', 'alice', 'alice', target('c2c', 'alice'));
    expect(f.services.agentPresets.mount).not.toHaveBeenCalled(); expect(record.agentPreset).toBeUndefined();
    expect(f.manager.getStatus('c2c', 'alice')).toMatchObject({ preset: undefined, defaultPreset: 'creative' });
  });

  it('shares new-session preset defaults while keeping existing preset compositions', async () => {
    const f = fixture(), privateChat = await f.manager.getOrCreate('c2c', 'alice', 'alice', target('c2c', 'alice'));
    await f.manager.setPresetOverride('group', 'room', 'creative');
    expect(f.manager.getEffectivePreset('c2c', 'alice')).toBe('creative');
    await f.manager.getOrCreate('c2c', 'alice', 'alice', target('c2c', 'alice'));
    expect(f.manager.getStatus('c2c', 'alice')).toMatchObject({ preset: 'standard', defaultPreset: 'creative' });
    const newGroup = await f.manager.getOrCreate('group', 'new-room', 'bob', target('group', 'new-room'));
    expect(newGroup.agentPreset).toBe('creative'); expect(privateChat.agentPreset).toBe('standard');
    await f.manager.clearPresetOverride('c2c', 'alice'); expect(f.manager.getEffectivePreset('group', 'room')).toBe('standard');
    expect(f.manager.getStatus('group', 'new-room')).toMatchObject({ preset: 'creative', defaultPreset: 'standard' });
  });

  it('does not silently replace a corrupt or unavailable persisted composition with a new Session', async () => {
    const f = fixture(), id = f.manager.currentSessionIdFor('c2c', 'alice');
    f.stored.set(id, { headerPreset: 'missing', projectedPreset: 'missing', history: [{ type: 'turn/start' }] });
    await expect(f.manager.getOrCreate('c2c', 'alice', 'alice', target('c2c', 'alice'))).rejects.toThrow('Unknown preset');
    expect(f.agents.create).not.toHaveBeenCalled(); expect(f.agents.resume).not.toHaveBeenCalled();
    f.services.sessionQuery.observeSession.mockRejectedValue(Object.assign(new Error('Corrupt log'), { code: 'SESSION_QUERY_CORRUPT_SESSION' }));
    await expect(f.manager.getOrCreate('c2c', 'alice', 'alice', target('c2c', 'alice'))).rejects.toThrow('Corrupt log');
    expect(f.agents.create).not.toHaveBeenCalled();
  });

  it('serializes concurrent admissions so an accepted native selection is not appended twice', async () => {
    const f = fixture(), record = await f.manager.getOrCreate('c2c', 'alice', 'alice', target('c2c', 'alice'));
    await f.manager.setModelOverride('group', 'room', route('next'));
    await Promise.all([f.manager.getOrCreate('c2c', 'alice', 'alice', record.replyTarget), f.manager.getOrCreate('c2c', 'alice', 'alice', record.replyTarget)]);
    expect(f.selectModel).toHaveBeenCalledTimes(1); expect(record.agent.session.events?.filter(event => event.type === 'model/selection')).toHaveLength(1);
  });

  it('reports the latest native request instead of a stale accepted-selection cache', async () => {
    const f = fixture(), id = f.manager.currentSessionIdFor('c2c', 'alice');
    const previous: Stored = { headerPreset: 'standard', projectedPreset: 'standard', lastRoute: route('old'), history: [{ type: 'turn/start' }] };
    f.stored.set(id, previous);
    const record = await f.manager.getOrCreate('c2c', 'alice', 'alice', target('c2c', 'alice'));
    expect(record.selectedModel).toEqual(route('configured'));
    // A later native request is a new fact even if another entry point selected it.
    previous.lastRoute = route('native-later'); f.projections.get(record.agent.session)!.pending = null;
    expect(f.manager.getStatus('c2c', 'alice')).toMatchObject({ model: 'native-later', defaultModel: 'configured' });
    await f.manager.getOrCreate('c2c', 'alice', 'alice', record.replyTarget);
    expect(f.selectModel).toHaveBeenLastCalledWith({ sessionId: id, ...route('configured') });
  });

  it('rejects an unknown command model before changing the shared default for any chat', async () => {
    const f = fixture();
    await expect(f.manager.setModelOverride('c2c', 'alice', route('unavailable-model'))).rejects.toThrow('未提供该模型');
    expect(f.manager.getEffectiveModel('c2c', 'alice')).toEqual(route('configured'));
    expect(f.manager.getEffectiveModel('group', 'room')).toEqual(route('configured'));
    expect(f.selectModel).not.toHaveBeenCalled();
  });

  it('does not promote a legacy discovery fallback when the native provider catalog cannot admit the route', async () => {
    const f = fixture();
    writeFileSync(join(home, 'settings.yaml'), 'llm-pi-ai:\n  providers:\n    fixture:\n      models:\n        - id: next\n');
    f.services.llm.listModels = vi.fn().mockRejectedValue(new Error('Native catalog unavailable'));
    await expect(f.manager.setModelOverride('c2c', 'alice', route('next'))).rejects.toThrow('Native catalog unavailable');
    expect(f.manager.getEffectiveModel('group', 'room')).toEqual(route('configured')); expect(f.selectModel).not.toHaveBeenCalled();
  });

});
