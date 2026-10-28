/**
 * dsh-im-qqbot 插件配置 Schema
 */
import Schema from '@deepseek-ai/schemastery';
export interface AccessControlConfig {
    /** C2C 访问模式 */
    c2cMode: 'open' | 'allowlist' | 'disabled';
    /** C2C 白名单（user openid） */
    c2cAllow: string[];
    /** 群聊访问模式 */
    groupMode: 'open' | 'allowlist' | 'disabled';
    /** 群聊白名单（group openid） */
    groupAllow: string[];
}
export interface MediaConfig {
    /** 是否启用富媒体理解（图片/视频下载 + 工具分析） */
    enabled: boolean;
    /** 富媒体下载大小上限（MiB），硬上限 30 */
    maxMB: number;
    /** 富媒体存活时长（小时，TTL），默认 24，0 = 永不过期 */
    ttlHours: number;
}
export interface VisionConfig {
    /** 是否启用视觉理解（qqbot_describe_image 工具） */
    enabled: boolean;
    /** 视觉模型 provider（dsh 注册的 llm adapter，如 pi-ai） */
    provider: string;
    /** 视觉模型 id（如 qwen-vl-max） */
    model: string;
    /** 默认描述 prompt（调用未显式指定时使用） */
    defaultPrompt: string;
    /** 图片字节上限，默认 10MB */
    maxBytes: number;
    /** 输出 token 上限 */
    maxTokens: number;
    /** 视觉调用超时(ms) */
    timeoutMs: number;
}
/** 附件发送配置（qqbot_send_file 工具与 present 交付物投递共用） */
export interface SendFileConfig {
    /** 是否启用路径白名单（默认 true，仅允许 media + cwd + extraRoots；关闭则任意路径） */
    restrictPaths: boolean;
    /** 额外允许访问的根目录（media 和 agent cwd 始终默认允许） */
    extraRoots: string[];
    /** 是否把 present 声明的交付文件在轮末发送到当前会话 */
    sendPresentedFiles: boolean;
    /** 单轮最多投递的交付文件数 */
    maxFiles: number;
}
export interface ImQQBotConfig {
    zeta?: {
        dataDir?: string;
        connectQQ?: boolean;
    };
    /** QQ Bot AppID */
    appId: string;
    /** QQ Bot AppSecret */
    appSecret: string;
    /** dsh LLM 提供商名称 */
    provider?: string;
    /** 模型名称 */
    model?: string;
    /** Agent preset id */
    preset?: string;
    /** Agent 工作目录（缺省回落到进程 cwd） */
    cwd?: string;
    /** 是否启用群消息 @mention 门控 */
    requireMention: boolean;
    /** 群聊额外 system prompt */
    groupPrompt?: string;
    /** 私聊额外 system prompt */
    directPrompt?: string;
    /** 单条消息最大长度（QQ 限制约 5000 字符） */
    textChunkLimit: number;
    /** 是否启用流式输出（群聊始终不启用） */
    streaming: boolean;
    /** 每会话最大闲置时长(ms)，超时自动回收 */
    sessionIdleTimeout: number;
    /** 并发队列最大长度 */
    maxQueue: number;
    /** 处理超时(ms)，超时中断当前 LLM 调用 */
    processingTimeoutMs: number;
    /** 待答问题超时(ms)，超时自动拒绝并提示（ask_user_question） */
    askTimeoutMs: number;
    /** 群历史缓冲条数 */
    historyLimit: number;
    /** 访问控制 */
    access: AccessControlConfig;
    /** 是否展示工具调用成功结果（工具错误始终展示） */
    showToolResults: boolean;
    /** 调试模式 */
    debug: boolean;
    /** 富媒体理解（图片/视频） */
    media: MediaConfig;
    /** 视觉理解（qqbot_describe_image 工具，走 dsh llm + attachments） */
    vision: VisionConfig;
    /** 附件发送（qqbot_send_file 工具与交付物投递共用） */
    sendFile: SendFileConfig;
}
/** 访问控制子 Schema（独立导出：config 路由的服务端校验复用） */
export declare const AccessControlSchema: Schema<AccessControlConfig>;
export declare const ConfigSchema: Schema<ImQQBotConfig>;
//# sourceMappingURL=config.d.ts.map