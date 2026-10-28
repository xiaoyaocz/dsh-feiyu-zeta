import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent';
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ScheduleRecord } from '@deepseek-ai/dsh-schedule';
import type { ModuleHost } from './contracts.ts';
import type { LifeState, ZetaState } from './state.ts';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'zeta-life': { kind: 'zeta-life'; mode: 'manual'; runId?: string };
    schedule: { kind: 'schedule' };
  }
}
const TASK_TITLE = 'ProjectZeta 自主生活';
const WAKE_PREFIX = '[PROJECTZETA_LIFE_WAKE]';
const RUN_MARKER = /\[ZETA_LIFE_RUN:([a-zA-Z0-9-]+)\]/;
export const lifeInstructions = [
  '这是内部自主生活空间，内部回答不会自动发送到QQ。可以探索、创作、整理、联系允许的对象或休息。',
  '只记录实际发生或工具证实的经历，计划与结果分开。通过 zeta_life_update 保存真实进展和关注。',
  '用 zeta_conversation_list 和 zeta_conversation_read 了解允许读取的聊天，不泄露他人私聊。',
  '主动联系必须指定允许的目标并使用插件发送工具；只有真实回执表示平台接受。',
  '每轮结束前调用 zeta_life_plan_next，自己决定下次活动时间，或 rest=true 暂不安排。',
  '没有固定活动周期；暂不安排后等待再次唤醒。不要为每个兴趣另建自动任务。',
  '可以用 zeta_identity_get / zeta_identity_update 查看并逐渐调整自己的名字、人设与长期习惯，无需管理员指令；不必每轮改动，不把聊天对象的隐私写进全局身份。',
  '自主活动不能修改管理员、插件、凭据或全局权限配置。',
].join('\n');
interface SessionsService { flush(session: Agent['session']): Promise<boolean> }
interface SessionControllerService {
  create(request: { cwd: string }): Promise<{ sessionId: string }>;
  resolveAgent(id: string): Promise<{ agent: Agent } | { error: unknown }>;
}
interface ScheduleService {
  create(id: string, request: { title: string; prompt: string; at: string }, signal?: AbortSignal): Promise<ScheduleRecord>;
  list(request: { sessionId: string }): Promise<ScheduleRecord[]>;
  delete(request: { sessionId: string; id: string }, signal?: AbortSignal): Promise<unknown>;
}
interface AgentRegistryService { get(id: string): Agent | undefined }
interface DefaultModelService { currentSelection(): { provider?: string; model?: string } }
type PreStepPayload = { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal };
function service<T>(ctx: Context, name: string): T | undefined {
  try { return (ctx as unknown as { get(name: string): unknown }).get(name) as T | undefined; } catch { return undefined; }
}
export class LifeError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'LifeError'; }
}
export function isLifeQuietTime(now: number, timeZone: string, start: number, end: number): boolean {
  if (start === end) return false;
  const hour = Number(new Intl.DateTimeFormat('en', { timeZone, hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(now)).find(part => part.type === 'hour')?.value);
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}
function dayAt(time: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time));
}
function automatic(message: UserMessage): boolean { return message.source.kind === 'schedule' || message.source.kind === 'zeta-life'; }
function runOf(message: UserMessage): string | undefined {
  if (message.source.kind === 'zeta-life') return message.source.runId;
  if (message.source.kind !== 'schedule') return undefined;
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').match(RUN_MARKER)?.[1];
}
function knownError(error: unknown): string { return error instanceof LifeError ? error.message : 'DSH自主会话或自动任务操作失败，请查看宿主运行记录。'; }

/** One durable internal Session and at most one active, AI-planned one-shot. */
export class LifeController {
  private readonly disposers: Array<() => void> = [];
  private readonly acceptedTurns = new Map<number, { startedAt: number; runId: string }>();
  private management: Promise<unknown> = Promise.resolve();
  private pending = new Set<Promise<unknown>>();
  private disposed = false;

  constructor(private readonly ctx: Context, private readonly state: ZetaState, private readonly host: ModuleHost) {
    this.disposers.push(ctx.on('agent/pre-step', (payload, next) => this.preStep(payload, next), { global: true }));
    this.disposers.push(ctx.on('session/event', (session, event) => {
      if (this.disposed || session.id !== this.state.life.sessionId || event.type !== 'turn/end') return;
      const accepted = this.acceptedTurns.get(event.data.turn);
      if (!accepted) return;
      this.acceptedTurns.delete(event.data.turn);
      this.observe(this.serialize(async () => {
        // turn/end is emitted before the loop necessarily publishes idle.
        const active = service<AgentRegistryService>(this.ctx, 'agents')?.get(session.id);
        if (active?.status === 'running') await active.whenIdle();
        await this.state.updateLife(current => {
          if (current.lastRunAt !== accepted.startedAt || current.claimedRunId !== accepted.runId || !this.state.settings.life.enabled) return current;
          const failed = event.data.reason.kind === 'error';
          const next: LifeState = { ...current, lastFinishedAt: Date.now(), status: failed ? 'error' : 'idle' };
          if (failed) next.error = '本轮自主生活执行失败；未自动安排固定周期重试。';
          else if (next.nextWakeAt === undefined && next.runId === accepted.runId) next.nextWakeReason = '本轮没有安排下次活动，等待再次唤醒。';
          return next;
        });
        if (this.state.settings.life.enabled) await this.reconcileInside();
      }));
    }));
    this.disposers.push(ctx.tools.register(defineTool({
      name: 'zeta_life_update', description: '仅内部自主生活会话保存真实进展和关注；安排下一次时间请使用 zeta_life_plan_next。',
      parameters: { summary: { type: 'string', required: true }, focus: { type: 'string' } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { saved: { type: 'boolean', required: true }, summary: { type: 'string', required: true }, focus: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec) => {
        this.requireInternal(exec.agent, exec.signal);
        const revision = this.state.life.planRevision, summary = args.summary.trim();
        if (!summary || summary.length > 1500 || (args.focus?.length ?? 0) > 500) throw new LifeError('INVALID_PROGRESS', '进展须为1至1500字，当前关注最多500字。');
        const updated = await this.state.updateLife(current => {
          this.requireInternal(exec.agent, exec.signal);
          if (current.planRevision !== revision) throw new LifeError('LIFE_CHANGED', '活动计划已改变，请重新读取状态。');
          return { ...current, summary, focus: args.focus === undefined ? current.focus : args.focus.trim() };
        });
        return { saved: true, summary: updated.summary, focus: updated.focus };
      },
    })));
    this.disposers.push(ctx.tools.register(defineTool({
      name: 'zeta_life_plan_next', description: '内部自主活动自己决定下次活动：next_at(带时区时间)、delay_minutes、rest=true 三选一。仅安排下一次，没有固定周期；返回实际接受时间。',
      parameters: { next_at: { type: 'string' }, delay_minutes: { type: 'number' }, rest: { type: 'boolean' }, reason: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { planned: { type: 'boolean', required: true }, nextWakeAt: { type: 'number' }, reason: { type: 'string', required: true }, adjusted: { type: 'boolean', required: true } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec) => {
        this.requireInternal(exec.agent, exec.signal);
        if (Number(args.next_at !== undefined) + Number(args.delay_minutes !== undefined) + Number(args.rest === true) !== 1) throw new LifeError('INVALID_PLAN', '下次时间、延迟分钟、暂不安排必须三选一。');
        const reason = args.reason.trim();
        if (!reason || reason.length > 500) throw new LifeError('INVALID_PLAN', '安排原因须为1至500字。');
        const now = Date.now();
        let requested: number | undefined;
        if (args.next_at !== undefined) {
          if (!/(Z|[+-]\d\d:\d\d)$/i.test(args.next_at)) throw new LifeError('INVALID_PLAN', '时间必须带明确时区。');
          requested = Date.parse(args.next_at);
        } else if (args.delay_minutes !== undefined) {
          if (!Number.isFinite(args.delay_minutes) || args.delay_minutes <= 0) throw new LifeError('INVALID_PLAN', '延迟分钟须为正数。');
          requested = now + args.delay_minutes * 60_000;
        }
        if (requested !== undefined && (!Number.isFinite(requested) || requested <= now || requested > now + 366 * 86400_000)) throw new LifeError('INVALID_PLAN', '下次活动须为未来一年内的时间。');
        const accepted = requested === undefined ? undefined : this.allowedTime(Math.max(requested, now + this.state.settings.life.minIntervalMinutes * 60_000));
        const revision = this.state.life.planRevision;
        const updated = await this.state.updateLife(current => {
          this.requireInternal(exec.agent, exec.signal);
          if (current.planRevision !== revision) throw new LifeError('LIFE_CHANGED', '活动计划已改变，请重新安排。');
          const value: LifeState = { ...current, planningInitialized: true, planRevision: current.planRevision + 1, runId: randomUUID(), nextWakeReason: reason };
          if (accepted === undefined) delete value.nextWakeAt; else value.nextWakeAt = accepted;
          return value;
        });
        return { planned: accepted !== undefined, ...(accepted === undefined ? {} : { nextWakeAt: accepted }), reason: updated.nextWakeReason, adjusted: accepted !== requested };
      },
    })));
  }
  private requireInternal(agent: unknown, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (!this.isInternal(agent)) throw new LifeError('LIFE_SCOPE', '此工具只允许内部自主生活会话使用。');
    if (!this.state.settings.life.enabled || this.disposed) throw new LifeError('LIFE_DISABLED', '自主生活已关闭。');
    this.host.requireWritable?.();
  }
  private observe<T>(operation: Promise<T>): void {
    this.pending.add(operation);
    void operation.catch(error => this.ctx.logger.warn('ProjectZeta自主生活：' + knownError(error))).finally(() => this.pending.delete(operation));
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.management.then(() => { if (this.disposed) throw new LifeError('LIFE_DISPOSED', '自主生活模块已卸载。'); return operation(); });
    this.management = task.catch(() => {}); return task;
  }
  private isInternal(agent: unknown): boolean {
    const value = agent as { id?: string; session?: { id?: string } } | undefined, id = this.state.life.sessionId;
    return !!id && !!value && (value.id === id || value.session?.id === id) && this.host.isLifeAgent(agent);
  }
  private allowedTime(time: number): number {
    const config = this.state.settings.life, current = this.state.life;
    let result = time;
    for (let minute = 0; minute < 3 * 1440; minute++) {
      const capped = current.runDay === dayAt(result, config.timeZone) && current.runCount >= config.maxDailyRuns;
      if (!capped && !isLifeQuietTime(result, config.timeZone, config.quietStart, config.quietEnd)) return result;
      result = Math.floor(result / 60_000) * 60_000 + 60_000;
    }
    throw new LifeError('LIFE_TIME', '当前活动限制下找不到可用的唤醒时间。');
  }
  private async preStep(payload: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> {
    const decision = await next();
    if (this.disposed || !this.isInternal(payload.agent) || decision.kind !== 'enter') return decision;
    const wakes = decision.messages.filter(automatic);
    if (!wakes.length) return decision;
    payload.signal.throwIfAborted();
    let acceptedMessage: UserMessage | undefined;
    const now = Date.now();
    await this.state.updateLife(current => {
      payload.signal.throwIfAborted();
      if (!this.state.settings.life.enabled || this.disposed || this.acceptedTurns.has(payload.turn)) return current;
      const wake = wakes.find(message => runOf(message) === current.runId && current.runId !== current.claimedRunId);
      if (!wake || !current.runId) return current;
      const manual = wake.source.kind === 'zeta-life';
      if (!manual && this.allowedTime(now) > now) return current;
      if (!manual && current.nextWakeAt !== undefined && current.nextWakeAt > now + 1000) return current;
      acceptedMessage = wake;
      const day = dayAt(now, this.state.settings.life.timeZone);
      const updated: LifeState = { ...current, claimedRunId: current.runId, lastRunAt: now, status: 'running', runDay: day, runCount: (current.runDay === day ? current.runCount : 0) + 1 };
      delete updated.nextWakeAt; delete updated.error; return updated;
    });
    if (acceptedMessage) this.acceptedTurns.set(payload.turn, { startedAt: now, runId: runOf(acceptedMessage)! });
    else if (this.state.settings.life.enabled && this.state.life.nextWakeAt !== undefined) this.observe((async () => {
      if (payload.agent.status === 'running') await payload.agent.whenIdle();
      if (!this.disposed) await this.reconcile();
    })());
    return { ...decision, messages: decision.messages.filter(message => !automatic(message) || message === acceptedMessage) };
  }
  private requireModel(): void {
    const selected = service<DefaultModelService>(this.ctx, 'agentDefaultModel')?.currentSelection();
    if (!selected?.provider?.trim() || !selected.model?.trim()) throw new LifeError('MODEL_REQUIRED', '请先在DSH中配置并选择主模型，再开启自主生活。');
  }
  private schedule(): ScheduleService {
    const value = service<ScheduleService>(this.ctx, 'schedule');
    if (!value) throw new LifeError('SCHEDULE_REQUIRED', '当前DSH未提供原生自动任务服务。');
    return value;
  }
  private async ensureSession(): Promise<Agent> {
    this.requireModel();
    const controller = service<SessionControllerService>(this.ctx, 'sessionController');
    if (!controller) throw new LifeError('SESSION_CONTROLLER_REQUIRED', '当前DSH未提供可持久恢复的会话控制器。');
    let id = this.state.life.sessionId;
    if (!id) { id = (await controller.create({ cwd: process.cwd() })).sessionId; await this.state.updateLife(current => ({ ...current, sessionId: id })); }
    const result = await controller.resolveAgent(id);
    if ('error' in result) throw new LifeError('SESSION_RESTORE_FAILED', '自主生活会话暂时无法恢复；为避免重复，不会另建替代会话。');
    return result.agent;
  }
  private owned(record: ScheduleRecord): boolean { return record.id === this.state.life.scheduleId || (record.title === TASK_TITLE && record.prompt.startsWith(WAKE_PREFIX)); }
  private async recordError(error: unknown): Promise<void> { await this.state.updateLife(current => ({ ...current, status: 'error', error: knownError(error) })); }
  private async reconcileInside(): Promise<void> {
    if (!this.state.settings.life.enabled) { await this.deactivate(); return; }
    const schedule = this.schedule(), agent = await this.ensureSession();
    // A plan saved mid-turn must only be armed after the current activity ends.
    if (agent.status === 'running') return;
    if (!this.state.life.planningInitialized) {
      const nextWakeAt = this.allowedTime(Date.now() + 1000);
      await this.state.updateLife(current => ({ ...current, planningInitialized: true, planRevision: current.planRevision + 1, runId: randomUUID(), nextWakeAt, nextWakeReason: '首次开启，先由AI决定下一次活动。' }));
    }
    const saved = this.state.life, sessionId = saved.sessionId!;
    let when = saved.nextWakeAt;
    if (when !== undefined) {
      when = this.allowedTime(Math.max(when, Date.now() + 1000));
      if (when !== saved.nextWakeAt) await this.state.updateLife(current => ({ ...current, nextWakeAt: when }));
    }
    const prompt = WAKE_PREFIX + ' [ZETA_LIFE_RUN:' + saved.runId + '] 这是DSH内部自动唤醒，不是QQ用户请求。\n' + lifeInstructions;
    const owned = (await schedule.list({ sessionId })).filter(record => this.owned(record));
    const matching = when !== undefined ? owned.find(record => record.kind === 'at' && record.prompt === prompt && Date.parse(record.scheduledAt) === when) : undefined;
    for (const record of owned) if (record !== matching) await schedule.delete({ sessionId, id: record.id });
    if (when === undefined) {
      await this.state.updateLife(current => { const value = { ...current, status: current.status === 'error' ? 'error' as const : 'idle' as const }; delete value.scheduleId; delete value.intervalMinutes; return value; }); return;
    }
    const chosen = matching ?? await schedule.create(sessionId, { title: TASK_TITLE, prompt, at: new Date(when).toISOString() });
    if (this.state.life.runId !== saved.runId || !this.state.settings.life.enabled) {
      await schedule.delete({ sessionId, id: chosen.id });
      return;
    }
    await this.state.updateLife(current => {
      if (current.runId !== saved.runId || !this.state.settings.life.enabled) return current;
      const updated: LifeState = { ...current, scheduleId: chosen.id, status: 'idle' };
      delete updated.intervalMinutes; delete updated.error; return updated;
    });
  }
  reconcile(): Promise<void> { return this.serialize(async () => { try { await this.reconcileInside(); } catch (error) { await this.recordError(error); throw error; } }); }
  runNow(): Promise<unknown> {
    return this.serialize(async () => {
      try {
        if (!this.state.settings.life.enabled) throw new LifeError('LIFE_DISABLED', '请先开启自主生活。');
        const agent = await this.ensureSession();
        if (agent.status === 'running') return { accepted: false, status: 'busy', sessionId: agent.id };
        const runId = randomUUID();
        await this.state.updateLife(current => { const value: LifeState = { ...current, planningInitialized: true, planRevision: current.planRevision + 1, runId, nextWakeReason: '管理者立即唤醒' }; delete value.nextWakeAt; return value; });
        for (const record of await this.schedule().list({ sessionId: this.state.life.sessionId! })) if (this.owned(record)) await this.schedule().delete({ sessionId: this.state.life.sessionId!, id: record.id });
        const message = createUserMessage({ source: { kind: 'zeta-life', mode: 'manual', runId }, content: [{ type: 'text', text: '管理者手动触发内部回合，仍须遵守主动发送规则。\n' + lifeInstructions }] });
        agent.followup(message);
        const sessions = service<SessionsService>(this.ctx, 'sessions');
        return { accepted: true, status: 'queued', sessionId: agent.id, messageId: message.id, persisted: sessions ? await sessions.flush(agent.session) : false };
      } catch (error) { await this.recordError(error); throw error; }
    });
  }
  private async deactivate(): Promise<void> {
    const saved = this.state.life;
    this.acceptedTurns.clear();
    await this.state.updateLife(current => {
      const value: LifeState = { ...current, planRevision: current.planRevision + 1, planningInitialized: false, status: 'disabled' };
      delete value.runId; delete value.nextWakeAt; delete value.scheduleId; delete value.intervalMinutes; delete value.error; return value;
    });
    if (!saved.sessionId) return;
    const active = service<AgentRegistryService>(this.ctx, 'agents')?.get(saved.sessionId);
    if (active) { active.cancel({ kind: 'user' }); await active.whenIdle(); }
    const schedule = service<ScheduleService>(this.ctx, 'schedule');
    if (!schedule && saved.scheduleId) throw new LifeError('SCHEDULE_REQUIRED', '自动任务服务不可用，尚未确认撤销原任务。');
    if (schedule) for (const record of await schedule.list({ sessionId: saved.sessionId })) if (record.id === saved.scheduleId || this.owned(record)) await schedule.delete({ sessionId: saved.sessionId, id: record.id });
  }
  stop(): Promise<void> {
    return this.serialize(async () => {
      const settings = this.state.settings; await this.state.setSettings({ ...settings, life: { ...settings.life, enabled: false } }, { preserveIdentity: true });
      try { await this.deactivate(); } catch (error) { await this.recordError(error); throw error; }
    });
  }
  status(): LifeState & { enabled: boolean } { return { ...this.state.life, enabled: this.state.settings.life.enabled }; }
  contextText(): string {
    const config = this.state.settings.life, life = this.state.life;
    return lifeInstructions + '\n兴趣与活动方向：' + config.interests + '\n当前关注：' + (life.focus || '暂无') + '\n最近实际进展：' + (life.summary || '尚无记录') + '\n下次活动：' + (life.nextWakeAt ? new Date(life.nextWakeAt).toISOString() : '尚未安排') + '；' + life.nextWakeReason + '\n可读取会话：' + (config.readTargets.join('、') || '未配置') + '\n允许联系目标：' + (config.targets.join('、') || '未配置') + '\n主动联系：' + (config.allowContact ? '仅允许配置目标，受安静时段、冷却和上限约束' : '关闭') + '。';
  }
  async dispose(): Promise<void> {
    if (this.disposed) return; this.disposed = true;
    for (const dispose of this.disposers.splice(0).reverse()) dispose();
    await this.management;
    const id = this.state.life.sessionId, active = id ? service<AgentRegistryService>(this.ctx, 'agents')?.get(id) : undefined;
    if (active) { active.cancel({ kind: 'disposed' }); await active.whenIdle(); }
    await Promise.allSettled([...this.pending]); this.acceptedTurns.clear();
  }
}
export function registerLife(ctx: Context, state: ZetaState, host: ModuleHost): LifeController {
  if (state.life.sessionId) SessionId(state.life.sessionId);
  return new LifeController(ctx, state, host);
}
