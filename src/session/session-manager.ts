/**
 * SessionManager — 管理 QQ peer → dsh Agent 的映射和生命周期
 *
 * sessionKey 格式: `qqbot:${appId}:${kind}:${peerId}`
 *   - c2c:   peerId = senderId (用户 openid)
 *   - group: peerId = groupOpenid
 *
 * SessionId 由 sessionKey 确定性派生（SHA-256），
 * 保证同一个用户/群的消息始终路由到同一个会话，
 * 重启后可根据 key 恢复 session。
 *
 * 支持 agent-presets 系统：通过 setup hook 在 create/resume 时
 * 挂载 preset（工具集、prompt sections 等），实现场景化配置。
 */
import { createHash, randomUUID } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type { Context } from '@deepseek-ai/cordis';
import type { ChatScope, Logger, ReplyTarget } from '../types.ts';
import type { ImQQBotConfig } from '../config.ts';
import { ModelResolver } from '../model/model-resolver.ts';
import type { ModelRoute, ModelEntry } from '../model/types.ts';
import { IdleEvictor } from './idle-evictor.ts';
import type { QuestionChannel } from '../features/question-channel.ts';
import type { ApprovalChannel } from '../features/approval-channel.ts';
import type {
  SessionEventLike,
  DshAgent,
  DshAgentHandle,
  DshAgentRegistry,
  AgentPresetsLike,
  PresetComposition,
  PresetEntry,
  PresetSwitchOutcome,
  SessionRecord,
  SessionStatus,
  TokenUsageStats,
  CompactionServiceLike,
  CompactOutcome,
} from './types.ts';

/** ManualCompactionError 各 code 的友好提示 */
const COMPACTION_ERROR_HINTS: Record<string, string> = {
  busy: '压缩服务忙，请稍后重试',
  cancelled: '压缩已取消',
  changed: '历史在压缩过程中发生变化，请重试',
  commit: '压缩提交失败',
  persistence: '压缩完成但保存失败',
};

/** system-prompt section 最小结构（name/order/text） */
interface PromptSection {
  name: string;
  order: number;
  text: string;
}

/** system-prompt/assemble waterfall 的 context 最小结构 */
interface AssembleContext {
  agent?: DshAgent;
}

/** system-prompt/assemble 的组装产物最小结构 */
interface AssembledPrompt {
  sections?: PromptSection[];
  [key: string]: unknown;
}

interface PersistedPreset { preset?: string }
interface PresetObservation {
  header: { agentPreset?: string };
  projections?: { values: Record<string, unknown> };
  [Symbol.dispose](): void;
}

function modelRoute(value: unknown): ModelRoute | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const route = value as { provider?: unknown; model?: unknown };
  return typeof route.provider === 'string' && route.provider && typeof route.model === 'string' && route.model
    ? { provider: route.provider, model: route.model } : undefined;
}

function sameRoute(left: ModelRoute | undefined, right: ModelRoute): boolean {
  return left?.provider === right.provider && left.model === right.model;
}

export class SessionManager {
  private sessions = new Map<string, SessionRecord>();
  private readonly evictor: IdleEvictor;
  private readonly modelResolver: ModelResolver;
  private readonly ctx: Context;
  private readonly agents: DshAgentRegistry;
  private readonly config: ImQQBotConfig;
  private readonly logger: Logger;
  private readonly modelUpdates = new WeakMap<DshAgent, Promise<void>>();
  /** 由 bootstrap 注入的问答通道（ask_user_question → QQ），会话回收时清理其待答问题 */
  public questionChannel?: QuestionChannel;
  /** 由 bootstrap 注入的审批通道（approval/request → QQ），会话回收时清理其待批审批 */
  public approvalChannel?: ApprovalChannel;
  public waitForReplies?: (sessionId: string, signal?: AbortSignal) => Promise<void>;

  constructor(
    ctx: Context,
    agents: DshAgentRegistry,
    config: ImQQBotConfig,
    logger: Logger,
  ) {
    this.ctx = ctx;
    this.agents = agents;
    this.config = config;
    this.logger = logger;
    this.modelResolver = new ModelResolver(ctx, config, logger);

    this.evictor = new IdleEvictor(
      this.sessions,
      config.sessionIdleTimeout,
      (key, record) => {
        this.logger.info(`evicting idle session: key=${key}`);
        this.sessions.delete(key);
        record.agent.cancel({ kind: 'user' });
        void record.handle.dispose().catch(() => {});
        // 回收会话时统一清理其待答问题/待批审批，避免 pending 悬挂泄漏
        this.questionChannel?.cancelPending(key);
        this.approvalChannel?.cancelPending(key);
      },
    );

    this.registerScopePromptInjection();
  }

  /**
   * 通过 system-prompt/assemble waterfall 注入群聊/私聊额外 system prompt。
   *
   * 该事件在每次 turn 构建 request 时触发；此处按会话 scope（群聊/私聊）
   * 追加对应的额外 prompt section。会话尚未建立（首次 assemble）或未配置
   * 额外 prompt 时原样返回，不做改动。
   */
  private registerScopePromptInjection(): void {
    const assemble = async (
      _assembly: unknown,
      context: AssembleContext,
      next: () => Promise<AssembledPrompt>,
    ): Promise<AssembledPrompt> => {
      const assembled = await next();
      if (!context.agent) return assembled;

      const record = this.findByAgent(context.agent);
      if (!record) return assembled;

      const prompt = record.scope === 'group' ? this.config.groupPrompt : this.config.directPrompt;
      const responsiveness = record.scope === 'group'
        ? '需要较长时间的任务，先判断是否参与群聊；只有决定reply后，才用zeta_send_message自然说明你准备做什么，再执行任务。执行中有实际阶段变化且值得告知时，可主动用发送工具简短说明进度。不要发送固定接收模板，不要虚构进展或重复已发送的内容；skip保持沉默。'
        : '需要较长时间的搜索、浏览、生图、语音或网页制作任务，先用你自己的话简短说明准备做什么，再调用工具。普通assistant正文会直接发到当前QQ，可作为开场确认；也可使用zeta_send_message，但同一段话只发送一次。执行中有实际阶段变化且值得告知时，可自然说明进度；不要只在所有工具完成后才回应，也不要虚构进展、照抄固定接收模板或重复已发内容。';

      return {
        ...assembled,
        sections: [...(assembled.sections ?? []), { name: 'qqbot:responsiveness', order: 85, text: responsiveness }, ...(prompt ? [{ name: 'qqbot:scope-prompt', order: 90, text: prompt }] : [])],
      };
    };

    (this.ctx as unknown as {
      on(event: 'system-prompt/assemble', handler: typeof assemble): void;
    }).on('system-prompt/assemble', assemble);
  }

  /**
   * 动态获取 agentPresets 服务（可选，未注入时返回 undefined）
   */
  private getPresetsService(): AgentPresetsLike | undefined {
    try {
      return this.ctx.get('agentPresets') as AgentPresetsLike | undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Read the native projection, including blank-session selection events.
   * An existing Session without a preset must not acquire the new default.
   */
  private async resolvePersistedPreset(sessionId: string): Promise<PersistedPreset | undefined> {
    const query = this.getService('sessionQuery') as { observeSession(id: string, options: { projectionMode: 'all' }): Promise<PresetObservation> } | undefined;
    if (query) {
      try {
        const observation = await query.observeSession(sessionId, { projectionMode: 'all' });
        try {
          const projected = observation.projections?.values.agentPreset;
          return { preset: typeof projected === 'string' ? projected : projected === null ? undefined : observation.header.agentPreset };
        } finally { observation[Symbol.dispose](); }
      } catch (err) {
        // A fresh deterministic QQ id normally has no stored Session yet.
        if ((err as { code?: unknown } | null)?.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw err;
      }
    }
    let persistence: { stat(id: string): Promise<{ header?: { agentPreset?: string } } | undefined> } | undefined;
    try {
      persistence = this.ctx.get('sessionPersistence') as typeof persistence | undefined;
    } catch {
      return undefined;
    }
    if (!persistence) return undefined;
    try {
      const stored = await persistence.stat(sessionId);
      return stored ? { preset: stored.header?.agentPreset } : undefined;
    } catch {
      return undefined;
    }
  }

  // ── 模型相关（委托给 ModelResolver） ──

  getEffectiveModel(scope: ChatScope, peerId: string): ModelRoute | undefined {
    return this.modelResolver.getEffectiveRoute(this.sessionKey(scope, peerId));
  }

  /**
   * 获取所有 QQ 新会话共享的 preset 默认。
   */
  getEffectivePreset(scope: ChatScope, peerId: string): string | undefined {
    return this.getEffectivePresetByKey(this.sessionKey(scope, peerId));
  }

  /** 按 sessionKey 解析生效 preset */
  private getEffectivePresetByKey(key: string): string | undefined {
    return this.modelResolver.getPreset(key)?.trim() || this.config.preset?.trim() || this.getPresetsService()?.defaultId;
  }

  /**
   * 列出所有可用 preset（/preset 命令用）
   */
  async listPresets(): Promise<PresetEntry[]> {
    const presets = this.getPresetsService();
    if (!presets) return [];
    try {
      const list = await presets.list();
      return list.map((p) => ({ id: p.id, name: p.name, description: p.description }));
    } catch (err) {
      this.logger.warn(`list presets failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * 从任一聊天保存公共模型；运行中的 Agent 留到下次请求再对齐。
   */
  async setModelOverride(scope: ChatScope, peerId: string, route: ModelRoute): Promise<void> {
    const key = this.sessionKey(scope, peerId);
    const normalized = { provider: route.provider.trim(), model: route.model.trim() };
    if (!normalized.provider || !normalized.model || normalized.provider.length > 160 || normalized.model.length > 240) throw new Error('模型配置无效');
    const llm = this.getService('llm') as { listProviders?(): Array<string | { id: string }>; listModels?(provider: string): Promise<readonly { id: string }[]> } | undefined;
    let available: boolean;
    if (typeof llm?.listProviders === 'function' && typeof llm.listModels === 'function') {
      // Match native selectModel admission, not the legacy discovery fallback.
      available = llm.listProviders().some(provider => (typeof provider === 'string' ? provider : provider.id) === normalized.provider)
        && (await llm.listModels(normalized.provider)).some(model => model.id === normalized.model);
    } else {
      available = (await this.modelResolver.listModels()).some(model => model.provider === normalized.provider && model.id === normalized.model);
    }
    if (!available) throw new Error('当前部署未提供该模型，请先在宿主配置或注册后查看 /model 列表。');
    this.modelResolver.setOverride(key, normalized);
    this.logger.info(`shared QQ model saved: appId=${this.config.appId} → ${normalized.provider}/${normalized.model}`);
  }

  /**
   * 修改所有 QQ 新会话的公共 preset 默认。
   *
   * 已开始的会话保持锁定（blank-session contract）：只持久化为新会话默认，
   * 不 fork/rebuild 当前会话，避免历史工具调用与新 preset 工具集冲突。
   */
  async setPresetOverride(scope: ChatScope, peerId: string, presetId: string): Promise<PresetSwitchOutcome> {
    const key = this.sessionKey(scope, peerId);

    // 1. 校验 preset 存在 + 可加载（broken 拒绝）
    const presets = this.getPresetsService();
    if (!presets) return { ok: false, reason: 'unavailable' };
    let resolved: { id: string; broken?: string };
    try {
      resolved = await presets.resolve(presetId);
    } catch (err) {
      return { ok: false, reason: 'unknown-preset', message: err instanceof Error ? err.message : String(err) };
    }
    if (resolved.broken !== undefined) {
      return { ok: false, reason: 'broken', message: resolved.broken };
    }

    // 2. 持久化公共默认（已开始的会话保留自己的原生 preset）
    this.modelResolver.setPreset(key, resolved.id);

    const hasActive = this.sessions.has(key);
    this.logger.info(
      `shared QQ preset saved: appId=${this.config.appId} → ${resolved.id}${hasActive ? ' (active session locked, new sessions apply)' : ''}`,
    );
    return { ok: true, presetId: resolved.id };
  }

  /**
   * 清除公共 preset 覆盖，回到 config.preset / 默认（新会话生效）
   */
  async clearPresetOverride(scope: ChatScope, peerId: string): Promise<PresetSwitchOutcome> {
    const key = this.sessionKey(scope, peerId);
    this.modelResolver.clearPreset(key);
    this.logger.info(`shared QQ preset cleared: appId=${this.config.appId} (new sessions apply)`);
    return { ok: true };
  }

  clearModelOverride(scope: ChatScope, peerId: string): void {
    const key = this.sessionKey(scope, peerId);
    this.modelResolver.clearOverride(key);
  }

  async listAvailableModels(): Promise<ModelEntry[]> {
    return this.modelResolver.listModels();
  }

  listProviders(): string[] {
    return this.modelResolver.listProviders();
  }

  // ── 会话状态 / 统计 ──

  getSessionRecord(scope: ChatScope, peerId: string): SessionRecord | undefined {
    return this.sessions.get(this.sessionKey(scope, peerId));
  }

  /** Stable current identity, including /new preferences while the Agent is cold. */
  currentSessionIdFor(scope: ChatScope, peerId: string): string {
    const key = this.sessionKey(scope, peerId);
    return this.sessions.get(key)?.sessionId ?? this.currentSessionId(key);
  }

  getStatus(scope: ChatScope, peerId: string): SessionStatus {
    const record = this.getSessionRecord(scope, peerId);
    const route = record ? this.currentModel(record) : undefined;
    const shared = this.getEffectiveModel(scope, peerId);

    return {
      active: !!record,
      sessionId: record?.sessionId,
      provider: route?.provider,
      model: route?.model,
      preset: record ? this.presetForAgent(record.agent) ?? record.agentPreset : undefined,
      defaultProvider: shared?.provider,
      defaultModel: shared?.model,
      defaultPreset: this.getEffectivePreset(scope, peerId),
      lastActivity: record?.lastActivity,
      messageCount: this.countMessages(record),
    };
  }

  getTokenUsage(scope: ChatScope, peerId: string): TokenUsageStats {
    const record = this.getSessionRecord(scope, peerId);
    const stats: TokenUsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

    const events = record?.agent.session.events;
    if (!events) return stats;

    for (const event of events) {
      const usage = event.data?.usage ?? event.usage;
      if (event.type !== 'assistant/message' || !usage) continue;
      stats.input += usage.input ?? 0;
      stats.output += usage.output ?? 0;
      stats.cacheRead += usage.cacheRead ?? 0;
      stats.cacheWrite += usage.cacheWrite ?? 0;
    }

    return stats;
  }

  exportMarkdown(scope: ChatScope, peerId: string): string {
    const record = this.getSessionRecord(scope, peerId);
    if (!record) return '';

    const events = record.agent.session.events;
    if (!events || events.length === 0) return '';

    const lines: string[] = [`# QQ 会话导出\n`, `> session: ${record.sessionId}\n`];

    for (const event of events) {
      if (event.type === 'user/message') {
        const text = extractMessageText(event.data?.message ?? event.message);
        if (text) lines.push(`## 用户\n\n${text}\n`);
      } else if (event.type === 'assistant/message') {
        const text = extractMessageText(event.data?.message ?? event.message);
        if (text) lines.push(`## 助手\n\n${text}\n`);
      }
    }

    return lines.join('\n');
  }

  private countMessages(record: SessionRecord | undefined): number {
    const events = record?.agent.session.events;
    if (!events) return 0;

    let count = 0;
    for (const event of events) {
      if (event.type === 'user/message' || event.type === 'assistant/message') {
        count += 1;
      }
    }
    return count;
  }

  // ── Session 生命周期管理 ──

  private sessionKey(scope: ChatScope, peerId: string): string {
    return `qqbot:${this.config.appId}:${scope}:${peerId}`;
  }

  private getService(name: string): unknown {
    try { return this.ctx.get(name as never); } catch { return undefined; }
  }

  private projection(agent: DshAgent, name: string): unknown {
    const projections = this.getService('sessionProjections') as { stateOf(session: unknown, key: string): unknown } | undefined;
    try { return projections?.stateOf(agent.session, name); } catch { return undefined; }
  }

  private presetForAgent(agent: DshAgent): string | undefined {
    const mounted = this.getPresetsService()?.composedPreset?.(agent.ctx);
    if (mounted !== undefined) return mounted;
    const projected = this.projection(agent, 'agentPreset');
    return typeof projected === 'string' ? projected : projected === null ? undefined : agent.session.header?.agentPreset;
  }

  /** Native pending selection, last request and initial options are distinct facts. */
  private currentModel(record: SessionRecord): ModelRoute | undefined {
    const header = modelRoute(record.agent.session.requestHeader?.()?.config);
    if (record.agent.status === 'running' && header) return header;
    const pending = this.projection(record.agent, 'modelSelection') as { pending?: unknown } | undefined;
    if (pending !== undefined) return modelRoute(pending.pending) ?? header ?? modelRoute(record.agent.options);
    return record.selectedModel ?? header ?? modelRoute(record.agent.options);
  }

  /** Reconcile at admission, without cancelling or rebuilding any conversation. */
  private async alignModel(record: SessionRecord): Promise<void> {
    if (record.agent.status === 'running') return;
    const previous = this.modelUpdates.get(record.agent) ?? Promise.resolve();
    const update = previous.catch(() => {}).then(async () => {
      if (record.agent.status === 'running') return;
      const shared = this.modelResolver.getEffectiveRoute(record.sessionKey);
      if (sameRoute(this.currentModel(record), shared)) return;
      const result = await this.ctx.sessionController.selectModel({ sessionId: SessionId(record.sessionId), ...shared });
      record.selectedModel = modelRoute(result.selected) ?? shared;
    });
    this.modelUpdates.set(record.agent, update);
    try { await update; }
    finally { if (this.modelUpdates.get(record.agent) === update) this.modelUpdates.delete(record.agent); }
  }

  private deriveSessionId(sessionKey: string): string {
    const hash = createHash('sha256').update(sessionKey).digest('hex');
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  }

  private currentSessionId(sessionKey: string): string {
    return this.modelResolver.getSessionId(sessionKey) ?? this.deriveSessionId(sessionKey);
  }

  private async composePreset(presetId?: string, required = false): Promise<PresetComposition> {
    const presets = this.getPresetsService();
    if (!presets) {
      if (required && presetId !== undefined) throw new Error(`当前部署缺少会话原有 preset：${presetId}`);
      return {};
    }

    try {
      const resolved = await presets.resolve(presetId);
      const resolvedId = resolved.id;
      return {
        agentPreset: resolvedId,
        setup: async (agentCtx: Context) => {
          await presets.mount(agentCtx, resolvedId);
        },
      };
    } catch (err) {
      if (required) throw err;
      this.logger.warn(
        `im-qqbot: preset ${presetId ?? '(default)'} unavailable: ${err instanceof Error ? err.message : String(err)} — using host composition`,
      );
      return {};
    }
  }

  /** 获取或恢复或创建会话（get → resume → create） */
  async getOrCreate(
    scope: ChatScope,
    peerId: string,
    senderId: string,
    replyTarget: ReplyTarget,
  ): Promise<SessionRecord> {
    const key = this.sessionKey(scope, peerId);
    const existing = this.sessions.get(key);

    if (existing) {
      existing.replyTarget = replyTarget;
      existing.lastActivity = Date.now();
      await this.alignModel(existing);
      return existing;
    }

    const route = this.modelResolver.getEffectiveRoute(key);
    const sessionId = SessionId(this.currentSessionId(key));
    this.logger.info(`getOrCreate: key=${key} route=${route ? `${route.provider}/${route.model}` : 'host-default'} sessionId=${sessionId}`);

    let agent: DshAgent;
    let handle: DshAgentHandle | undefined;
    let agentPreset: string | undefined;

    const live = this.agents.get(sessionId);
    if (live) {
      agent = live;
      agentPreset = this.presetForAgent(live);
      this.logger.info(`reusing live agent: key=${key}`);
    } else {
      // preset 只解析一次：resume/create 共用同一组合，避免重复 resolve/mount 目录。
      // Stored Sessions retain their native projected preset. Only genuinely
      // new Sessions use the current shared default (including no-preset logs).
      const persisted = await this.resolvePersistedPreset(sessionId);
      const presetId = persisted ? persisted.preset : this.getEffectivePresetByKey(key);
      const composed = persisted && presetId === undefined ? {} : await this.composePreset(presetId, !!persisted);
      agentPreset = composed.agentPreset;
      try {
        const resumeRoute = this.modelResolver.getResumeRoute(key);
        const resumed = await this.agents.resume({
          resumeSessionId: sessionId,
          ...(resumeRoute ? { agentOptions: resumeRoute } : {}),
          ...(composed.setup ? { setup: composed.setup } : {}),
        });
        agent = resumed.agent;
        handle = resumed;
        this.logger.info(`resumed session: key=${key} preset=${agentPreset ?? 'none'} route=${resumeRoute ? `${resumeRoute.provider}/${resumeRoute.model}` : 'session-own'}`);
      } catch (error) {
        if (persisted) throw error;
        const created = await this.agents.create({
          sessionId,
          meta: {
            cwd: this.config.cwd || process.cwd(),
            ...(agentPreset ? { agentPreset } : {}),
          },
          ...(route ? { agentOptions: route } : {}),
          ...(composed.setup ? { setup: composed.setup } : {}),
        });
        agent = created.agent;
        handle = created;
        this.logger.info(`created new session: key=${key} preset=${agentPreset ?? 'none'}`);
      }
    }

    const record: SessionRecord = {
      sessionKey: key,
      sessionId,
      agent,
      handle: handle ?? { agent, dispose: async () => {} },
      replyTarget,
      scope,
      peerId,
      senderId,
      lastActivity: Date.now(),
      agentPreset,
    };

    this.sessions.set(key, record);
    await this.alignModel(record);
    return record;
  }

  findBySessionId(sessionId: string): SessionRecord | undefined {
    for (const record of this.sessions.values()) {
      if (record.sessionId === sessionId) return record;
    }
    return undefined;
  }

  findByAgent(agent: DshAgent): SessionRecord | undefined {
    for (const record of this.sessions.values()) {
      if (record.agent === agent) return record;
    }
    return undefined;
  }

  /** Urgent stop bypasses the inbox and also releases pending human prompts. */
  interrupt(scope: ChatScope, peerId: string): void {
    const record = this.getSessionRecord(scope, peerId);
    if (!record) return;
    record.abortRequest?.();
    record.agent.cancel({ kind: 'user' });
    this.questionChannel?.cancelPending(record.sessionKey);
    this.approvalChannel?.cancelPending(record.sessionKey);
  }

  async remove(scope: ChatScope, peerId: string): Promise<void> {
    const key = this.sessionKey(scope, peerId);
    const record = this.sessions.get(key);
    this.modelResolver.setSessionId(key, randomUUID());

    if (!record) return;
    this.sessions.delete(key);
    record.agent.cancel({ kind: 'user' });
    await record.handle.dispose().catch(() => {});
    this.logger.info(`session removed: key=${key}`);
  }

  /**
   * 原地压缩当前会话历史（保留 sessionId，用摘要替换旧历史）。
   *
   * 需通过 agentPresets.serviceFor(agent, 'compaction') 解析；未挂载时优雅降级。
   * 这是「压缩上下文」的语义，区别于 remove() 的「换新会话」。
   */
  async compact(scope: ChatScope, peerId: string): Promise<CompactOutcome> {
    const key = this.sessionKey(scope, peerId);
    const record = this.sessions.get(key);
    if (!record) return { ok: false, reason: 'no-session' };
    if (record.agent.status !== 'idle') return { ok: false, reason: 'busy' };

    let compaction: CompactionServiceLike | undefined;
    try {
      const presets = this.getPresetsService();
      compaction = (presets?.serviceFor(record.agent, 'compaction') ?? this.ctx.get('compaction')) as CompactionServiceLike | undefined;
    } catch {
      compaction = undefined;
    }
    if (!compaction) return { ok: false, reason: 'unavailable' };

    const route = this.modelResolver.getEffectiveRoute(key);
    const agentCtx = {
      session: record.agent.session,
      options: { provider: route?.provider, model: route?.model },
      runMaintenance: record.agent.runMaintenance.bind(record.agent),
    };

    try {
      const result = await compaction.compactNow(agentCtx, new AbortController().signal);
      if (result === null) return { ok: true, shadowed: 0, tokens: 0 };
      return { ok: true, shadowed: result.shadowedSeqs.length, tokens: result.shadowedTokenCount };
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      // summary = 摘要没有更小 = 历史不足以压缩，属正常结果而非失败
      if (code === 'summary') {
        return { ok: true, shadowed: 0, tokens: 0 };
      }
      // 其他 ManualCompactionError 预期失败，给友好文案（debug 记录，不 warn 刷屏）
      if (code !== undefined && code in COMPACTION_ERROR_HINTS) {
        this.logger.debug(`compact declined: key=${key} code=${code}`);
        return { ok: false, reason: 'failed', message: COMPACTION_ERROR_HINTS[code] };
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`compact failed: key=${key} err=${message}`);
      return { ok: false, reason: 'failed', message };
    }
  }

  async disposeAll(): Promise<void> {
    this.evictor.dispose();
    const records = [...this.sessions.values()];
    this.sessions.clear();
    for (const record of records) {
      record.agent.cancel({ kind: 'user' });
    }
    await Promise.allSettled(records.map((r) => r.handle.dispose()));
    this.logger.info(`all sessions disposed (count=${records.length})`);
  }

  /** Pause only this channel's active work; keep session ownership and mappings. */
  async quiesce(): Promise<void> {
    const agents = [...this.sessions.values()].map(record => record.agent);
    for (const agent of agents) agent.cancel({ kind: 'user' });
    await Promise.all(agents.map(agent => agent.whenIdle()));
  }

  get size(): number {
    return this.sessions.size;
  }
}

/** 从消息对象中提取纯文本（用于导出/统计） */
function extractMessageText(
  message: SessionEventLike['message'],
): string {
  const blocks = message?.content;
  if (!blocks || !Array.isArray(blocks)) return '';

  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}
