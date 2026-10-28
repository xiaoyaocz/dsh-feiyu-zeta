import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent';
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { ScheduleRecord } from '@deepseek-ai/dsh-schedule';
import type { ModuleHost } from './contracts.ts';
import { defaultSettings, type LifeState, type ZetaState, type ZetaSettings } from './state.ts';
import { isLifeQuietTime, registerLife } from './life.ts';

type Handler = (...args: any[]) => any;
function fixture(options: { enabled?: boolean; existingSession?: boolean; model?: boolean } = {}) {
  let settings = defaultSettings();
  settings.life.enabled = options.enabled ?? true;
  let life: LifeState = { lastRunAt: 0, lastFinishedAt: 0, status: 'disabled', summary: '', focus: '', contactDay: '', contactCount: 0, contacts: {}, planRevision: 0, nextWakeReason: '', planningInitialized: false, runDay: '', runCount: 0 };
  if (options.existingSession) life.sessionId = 'session-life';
  let chain: Promise<unknown> = Promise.resolve();
  const state = {
    get settings() { return structuredClone(settings); }, get life() { return structuredClone(life); },
    async setSettings(value: ZetaSettings) { settings = structuredClone(value); return settings; },
    updateLife(fn: (current: LifeState) => LifeState) {
      const task = chain.then(() => { life = structuredClone(fn(structuredClone(life))); return structuredClone(life); });
      chain = task.catch(() => {}); return task;
    },
  } as unknown as ZetaState;
  const handlers = new Map<string, Set<Handler>>(), tools = new Map<string, any>(), records = new Map<string, ScheduleRecord>();
  let scheduleNumber = 0;
  const agent = { id: SessionId('session-life'), session: { id: SessionId('session-life') }, status: 'idle', followup: vi.fn(), cancel: vi.fn(), whenIdle: vi.fn(async () => {}) } as unknown as Agent;
  const sessionController = { create: vi.fn(async () => ({ sessionId: 'session-life' })), resolveAgent: vi.fn(async () => ({ agent })) };
  const schedule = {
    create: vi.fn(async (_id: string, request: { title: string; prompt: string; at: string }) => {
      const id = 'schedule-' + ++scheduleNumber;
      const record = { id, kind: 'at', title: request.title, prompt: request.prompt, scheduledAt: request.at } as ScheduleRecord;
      records.set(id, record); return record;
    }),
    list: vi.fn(async () => [...records.values()]),
    delete: vi.fn(async ({ id }: { id: string }) => ({ id, deleted: records.delete(id) })),
  };
  const services = new Map<string, unknown>([
    ['sessionController', sessionController], ['schedule', schedule], ['agents', { get: vi.fn(() => agent) }],
    ['sessions', { flush: vi.fn(async () => true) }],
    ['agentDefaultModel', { currentSelection: () => options.model === false ? { provider: '', model: '' } : { provider: 'fixture', model: 'test' } }],
  ]);
  const ctx = {
    logger: { warn: vi.fn() }, get(name: string) { return services.get(name); },
    on(name: string, handler: Handler) {
      const group = handlers.get(name) ?? new Set<Handler>(); handlers.set(name, group); group.add(handler);
      return () => { group.delete(handler); };
    },
    tools: { register(tool: any) { tools.set(tool.name, tool); return () => { tools.delete(tool.name); }; } },
  } as unknown as Context;
  const host = { ctx, dataDir: 'unused', isLifeAgent(value: unknown) { return (value as Agent | undefined)?.id === life.sessionId; } } as ModuleHost;
  const controller = registerLife(ctx, state, host);
  const setLife = (patch: Partial<LifeState>) => state.updateLife(current => ({ ...current, ...patch }));
  const setConfig = (patch: Partial<ZetaSettings['life']>) => state.setSettings({ ...state.settings, life: { ...state.settings.life, ...patch } });
  async function step(messages: UserMessage[], nextValue?: PreStepDecision, turn = 1, ownAgent = agent) {
    const next = vi.fn(async () => nextValue ?? { kind: 'enter' as const, messages });
    const handler = [...handlers.get('agent/pre-step')!][0]!;
    return { result: await handler({ agent: ownAgent, messages, turn, step: 1, signal: new AbortController().signal }, next) as PreStepDecision, next };
  }
  function scheduleMessage(advance = true) {
    const record = records.get(state.life.scheduleId!)!;
    if (advance) vi.setSystemTime(new Date(record.scheduledAt));
    records.delete(record.id); // Native one-shot has been delivered and is no longer active.
    return createUserMessage({ source: { kind: 'schedule' }, content: [{ type: 'text', text: record.prompt }] });
  }
  const userMessage = () => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'ordinary input' }] });
  async function settle(turn = 1, reason: unknown = { kind: 'completed' }) {
    for (const handler of handlers.get('session/event') ?? []) handler(agent.session, { type: 'turn/end', data: { turn, reason } });
    await controller.reconcile();
  }
  const plan = (args: unknown, signal = new AbortController().signal, ownAgent = agent) => tools.get('zeta_life_plan_next').execute(args, { agent: ownAgent, signal });
  return { ctx, host, state, controller, setLife, setConfig, agent, sessionController, schedule, records, handlers, tools, services, step, scheduleMessage, userMessage, settle, plan };
}

describe('AI-planned native one-shot life', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-28T04:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('does no billable work when disabled, and checks model/services before enabling', async () => {
    const f = fixture({ enabled: false, model: false });
    await f.controller.reconcile();
    expect(f.sessionController.create).not.toHaveBeenCalled(); expect(f.schedule.create).not.toHaveBeenCalled();
    await expect(f.controller.runNow()).rejects.toMatchObject({ code: 'LIFE_DISABLED' });
    await f.controller.dispose();
    const missing = fixture({ model: false });
    await expect(missing.controller.reconcile()).rejects.toMatchObject({ code: 'MODEL_REQUIRED' });
    expect(missing.schedule.create).not.toHaveBeenCalled(); await missing.controller.dispose();
    const noSchedule = fixture(); noSchedule.services.delete('schedule');
    await expect(noSchedule.controller.reconcile()).rejects.toMatchObject({ code: 'SCHEDULE_REQUIRED' });
    expect(noSchedule.sessionController.create).not.toHaveBeenCalled(); await noSchedule.controller.dispose();
  });

  it('bootstraps only once and reuses a future one-shot across saves and restart', async () => {
    const f = fixture(); await f.controller.reconcile();
    const record = [...f.records.values()][0]!;
    expect(record.kind).toBe('at');
    expect(record.prompt).toContain('[ZETA_LIFE_RUN:');
    expect(f.schedule.create.mock.calls[0]![1]).not.toHaveProperty('every_seconds');
    await f.controller.reconcile();
    expect(f.schedule.create).toHaveBeenCalledTimes(1);
    await f.controller.dispose();
    const restored = registerLife(f.ctx, f.state, f.host); await restored.reconcile();
    expect(f.sessionController.create).toHaveBeenCalledTimes(1);
    expect([...f.records.values()][0]).toEqual(record);
    await restored.dispose();
  });

  it('uses different AI-selected delays and no fixed cycle, then can rest indefinitely', async () => {
    const f = fixture(); await f.controller.reconcile();
    await f.step([f.scheduleMessage()]);
    const first = await f.plan({ delay_minutes: 7, reason: '七分钟后继续观察' });
    expect(first.nextWakeAt).toBe(Date.now() + 7 * 60_000); await f.settle();
    expect(f.records.size).toBe(1);
    await f.step([f.scheduleMessage()], undefined, 2);
    const second = await f.plan({ delay_minutes: 43, reason: '休息一会再创作' });
    expect(second.nextWakeAt).toBe(Date.now() + 43 * 60_000); await f.settle(2);
    await f.step([f.scheduleMessage()], undefined, 3);
    expect(await f.plan({ rest: true, reason: '没有待办，等待新消息' })).toMatchObject({ planned: false });
    await f.settle(3);
    expect(f.records.size).toBe(0); expect(f.state.life.nextWakeAt).toBeUndefined();
    await f.controller.reconcile(); expect(f.records.size).toBe(0);
    await f.controller.dispose();
  });

  it('does not invent a fixed fallback when a round omits planning or fails', async () => {
    const f = fixture(); await f.controller.reconcile(); await f.step([f.scheduleMessage()]);
    await f.settle(1, { kind: 'error' });
    expect(f.state.life.status).toBe('error'); expect(f.records.size).toBe(0);
    expect(f.state.life.nextWakeAt).toBeUndefined(); await f.controller.dispose();
  });

  it('arms a saved plan after turn/end has actually reached idle', async () => {
    const f = fixture(); await f.controller.reconcile(); await f.step([f.scheduleMessage()]);
    await f.plan({ delay_minutes: 17, reason: '本轮结束后再等一会' });
    Object.assign(f.agent, { status: 'running' });
    await f.controller.reconcile(); expect(f.records.size).toBe(0);
    let release: (() => void) | undefined;
    Object.assign(f.agent, { whenIdle: vi.fn().mockResolvedValue(undefined).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; })) });
    for (const handler of f.handlers.get('session/event') ?? []) handler(f.agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    const completion = f.controller.reconcile();
    for (let i = 0; i < 5 && !release; i++) await Promise.resolve();
    expect(f.records.size).toBe(0); expect(release).toBeTypeOf('function');
    Object.assign(f.agent, { status: 'idle' }); release!(); await completion;
    expect(f.records.size).toBe(1); expect(f.state.life.status).toBe('idle'); await f.controller.dispose();
  });

  it('rejects malformed and unauthorized plans, preserves cancellation, and reports adjusted times', async () => {
    const f = fixture(); await f.controller.reconcile();
    await expect(f.plan({ delay_minutes: 5, rest: true, reason: 'bad' })).rejects.toMatchObject({ code: 'INVALID_PLAN' });
    await expect(f.plan({ next_at: '2026-10-28T14:00:00', reason: 'bad' })).rejects.toMatchObject({ code: 'INVALID_PLAN' });
    await expect(f.plan({ delay_minutes: -1, reason: 'bad' })).rejects.toMatchObject({ code: 'INVALID_PLAN' });
    await expect(f.plan({ rest: true, reason: 'other' }, undefined, { id: 'qq' } as Agent)).rejects.toMatchObject({ code: 'LIFE_SCOPE' });
    const aborted = new AbortController(); aborted.abort();
    await expect(f.plan({ rest: true, reason: 'cancelled' }, aborted.signal)).rejects.toThrow();
    const limited = await f.plan({ delay_minutes: 1, reason: '一分钟后' });
    expect(limited).toMatchObject({ adjusted: true, nextWakeAt: Date.now() + 5 * 60_000 });
    const quiet = await f.plan({ next_at: '2026-10-28T23:30:00+08:00', reason: '稍后' });
    expect(new Date(quiet.nextWakeAt).toISOString()).toBe('2026-10-29T00:00:00.000Z');
    await f.controller.dispose();
  });

  it('deduplicates at-least-once delivery with a durable run claim instead of a fixed interval', async () => {
    const f = fixture(); await f.controller.reconcile(); const wake = f.scheduleMessage();
    const results = await Promise.all([f.step([wake], undefined, 1), f.step([wake], undefined, 2)]);
    expect(results.map(value => value.result.kind === 'enter' ? value.result.messages.length : -1).sort()).toEqual([0, 1]);
    const claimed = f.state.life.claimedRunId;
    const duplicate = await f.step([wake], undefined, 3);
    expect(duplicate.result).toEqual({ kind: 'enter', messages: [] });
    expect(f.state.life.claimedRunId).toBe(claimed);
    await f.controller.dispose();
    const restarted = registerLife(f.ctx, f.state, f.host);
    const handler = [...f.handlers.get('agent/pre-step')!][0]!;
    expect(await handler({ agent: f.agent, messages: [wake], turn: 4, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [wake] }))).toEqual({ kind: 'enter', messages: [] });
    await restarted.dispose();
  });

  it('preserves downstream admission markers and unrelated input while rejecting stale wakes', async () => {
    const f = fixture(); await f.controller.reconcile(); const wake = f.scheduleMessage();
    const rejected = { kind: 'reject' as const };
    expect((await f.step([wake], rejected)).result).toBe(rejected);
    const ordinary = f.userMessage();
    const stale = createUserMessage({ source: { kind: 'schedule' }, content: [{ type: 'text', text: '[ZETA_LIFE_RUN:stale]' }] });
    expect((await f.step([stale, ordinary], { kind: 'enter', messages: [stale, ordinary], startsRequestSeries: true })).result).toEqual({ kind: 'enter', messages: [ordinary], startsRequestSeries: true });
    await f.controller.dispose();
  });

  it('repairs a crash after native task creation but before saving its id, and removes legacy recurrence', async () => {
    const f = fixture(); await f.controller.reconcile(); const record = [...f.records.values()][0]!;
    await f.setLife({ scheduleId: undefined });
    f.records.set('legacy', { id: 'legacy', kind: 'every', title: 'ProjectZeta 自主生活', prompt: '[PROJECTZETA_LIFE_WAKE] old', everySeconds: 3600, scheduledAt: record.scheduledAt } as ScheduleRecord);
    f.records.set('other', { ...record, id: 'other', title: 'user reminder', prompt: 'unrelated' } as ScheduleRecord);
    await f.controller.reconcile();
    expect(f.state.life.scheduleId).toBe(record.id); expect(f.schedule.create).toHaveBeenCalledTimes(1);
    expect(f.records.has('legacy')).toBe(false); expect(f.records.has('other')).toBe(true);
    await f.controller.dispose();
  });

  it('moves scheduling past the daily budget and rejects old queued wakes after stop/re-enable', async () => {
    const f = fixture(); await f.controller.reconcile(); const old = f.scheduleMessage();
    await f.controller.stop(); expect(f.state.settings.life.enabled).toBe(false);
    expect(f.agent.cancel).toHaveBeenCalledWith({ kind: 'user' }); expect(f.state.life.planningInitialized).toBe(false);
    await f.setConfig({ enabled: true }); await f.controller.reconcile();
    expect((await f.step([old])).result).toEqual({ kind: 'enter', messages: [] });
    await f.setLife({ runDay: '2026-10-28', runCount: 48 });
    const plan = await f.plan({ delay_minutes: 10, reason: '预算恢复后继续' });
    expect(new Date(plan.nextWakeAt).toISOString()).toBe('2026-10-29T00:00:00.000Z');
    await f.controller.dispose();
  });

  it('manual run replaces the old plan with a genuine native queued turn and bounded progress', async () => {
    const f = fixture(); await f.controller.reconcile();
    const receipt = await f.controller.runNow();
    expect(receipt).toMatchObject({ accepted: true, status: 'queued', persisted: true });
    const message = f.agent.followup.mock.calls[0]![0] as UserMessage;
    expect(message.source.kind).toBe('zeta-life'); expect(f.records.size).toBe(0);
    expect((await f.step([message])).result.kind).toBe('enter');
    const tool = f.tools.get('zeta_life_update'), exec = { agent: f.agent, signal: new AbortController().signal };
    expect(await tool.execute({ summary: '读完公开资料', focus: '继续核对' }, exec)).toMatchObject({ saved: true });
    expect(f.controller.contextText()).toContain('读完公开资料');
    await expect(tool.execute({ summary: 'x'.repeat(1501) }, exec)).rejects.toMatchObject({ code: 'INVALID_PROGRESS' });
    await f.controller.dispose();
    expect(f.tools.has('zeta_life_plan_next')).toBe(false);
  });

  it('uses explicit quiet-hour time zones including same-day and disabled windows', () => {
    const midnight = Date.parse('2026-10-28T16:00:00Z');
    expect(isLifeQuietTime(midnight, 'Asia/Shanghai', 23, 8)).toBe(true);
    expect(isLifeQuietTime(midnight, 'UTC', 23, 8)).toBe(false);
    expect(isLifeQuietTime(midnight, 'Asia/Shanghai', 0, 0)).toBe(false);
    expect(isLifeQuietTime(Date.parse('2026-10-28T04:00:00Z'), 'Asia/Shanghai', 10, 14)).toBe(true);
  });
});
