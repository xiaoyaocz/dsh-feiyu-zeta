/**
 * ModelResolver — 统一的模型发现与路由解析
 *
 * 职责：
 *   1. 解析当前生效的默认模型路由
 *   2. 列出可用 providers 和模型
 *   3. 管理同一 AppID 的公共模型和 preset 默认（委托 PrefsStore）
 *
 * 优先级（从高到低）：
 *   AppID 公共偏好（DSH_HOME/zeta/qq-model-prefs.json）
 *   > config 显式指定（cordis.yml 的 provider/model）
 *   > 宿主 agentDefaultModel 服务
 *   > 遗留 settings.yaml（只读兜底）
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import type { ModelRoute, ModelEntry } from './types.ts';
export declare class ModelResolver {
    private readonly prefs;
    private readonly settings;
    private readonly ctx;
    private readonly config;
    private readonly logger?;
    private readonly sharedKey;
    constructor(ctx: Context, config: ImQQBotConfig, logger?: Logger);
    /**
     * 所有 QQ 聊天读取同一 AppID 公共模型；旧 peer 记录保留但不再覆盖它。
     */
    getEffectiveRoute(_sessionKey: string): ModelRoute;
    /**
     * 获取 resume 时覆盖 session 的模型路由
     *
     * 与新建会话使用同一公共路由，避免旧会话恢复后继续分叉。
     *
     * 这里不返回 undefined，因为未装 installModelSelection，system-prompt 的
     * {{model}} 变量直接读 agent.options.model——若无值会抛
     * "prompt variable {{model}} has no value for this assembly"。
     * 因此兜底到默认链，确保 agent.options.model 始终有值。
     */
    getResumeRoute(sessionKey: string): ModelRoute;
    /**
     * 从任一聊天设置 AppID 公共模型，保留旧 peer 记录供备份兼容。
     */
    setOverride(_sessionKey: string, route: ModelRoute): void;
    /**
     * 清除公共模型偏好，回到插件配置／宿主当前默认。
     */
    clearOverride(_sessionKey: string): void;
    /**
     * 是否存在 AppID 公共模型偏好。
     */
    hasOverride(_sessionKey: string): boolean;
    /**
     * 获取指定 sessionKey 的最新 sessionId（fork 后记录，重启恢复用）
     */
    getSessionId(sessionKey: string): string | undefined;
    /**
     * 记录指定 sessionKey 的最新 sessionId（fork 后调用）并持久化
     */
    setSessionId(sessionKey: string, sessionId: string): void;
    /**
     * 清除指定 sessionKey 的 sessionId 记录
     */
    clearSessionId(sessionKey: string): void;
    /**
     * 获取 AppID 公共新会话 preset 默认。
     */
    getPreset(_sessionKey: string): string | undefined;
    /**
     * 设置公共新会话 preset 默认。
     */
    setPreset(_sessionKey: string, presetId: string): void;
    /**
     * 清除公共 preset 偏好；旧 peer 记录仍不参与选择。
     */
    clearPreset(_sessionKey: string): boolean;
    /**
     * 解析默认模型路由（不含公共聊天命令偏好）
     *
     * 优先级：config 显式指定 > 宿主动态默认 > 遗留 settings.yaml（只读）
     * 最终兜底 deepseek-official/deepseek-v4-flash，确保 {{model}} 变量始终有值。
     */
    resolveDefault(): ModelRoute;
    /**
     * 列出所有可用模型
     *
     * 优先走 ctx.llm 服务动态发现，服务不可用或失败时回退 settings.yaml 静态配置。
     */
    listModels(): Promise<ModelEntry[]>;
    /**
     * 列出可用 provider 名称
     */
    listProviders(): string[];
    private readFromHost;
    /** 统一的 Cordis 服务访问（可选获取：服务未注入时静默返回 undefined，避免 Proxy 抛错） */
    private getService;
    /** 获取 ctx.llm 服务（最小接口收窄，不可用时返回 undefined） */
    private getLlmService;
}
/** Configuration identity only: never use it as a conversation/session identity. */
export declare function sharedPreferencesKey(appId: string): string;
//# sourceMappingURL=model-resolver.d.ts.map