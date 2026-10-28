import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { SessionManager } from "../session/index.js";
import { handleInbound, createOutboundHandler } from "../transport/index.js";
import { parseStreamFrame } from "../transport/events.js";
import { ReplyLimiter } from "../transport/reply-limiter.js";
import { cacheMsgId, cacheEventId } from "../transport/msgid-cache.js";
import { resolveReplyTarget, sendResolvedMarkdown } from "../transport/reply-target.js";
import { QuestionChannel } from "../features/question-channel.js";
import { ApprovalChannel } from "../features/approval-channel.js";
import { decodeButtonData } from "../features/button-utils.js";
import { buildUserAgent } from "../shared/index.js";
import { setupMiddlewares } from "./middleware-setup.js";
import { startMediaCleanup } from "../media/media-cleaner.js";
import { ensureVisionInputModal, registerDescribeImageTool } from "../media/vision-tool.js";
import { registerSendFileTool } from "../media/send-file-tool.js";
import { DeliverablesDeliverer } from "../transport/deliverables.js";
import { observeGroupLifecycle } from "../zeta/discovery.js";
import { GroupInbox } from "../transport/group-inbox.js";
import { splitRequestBatches } from "../zeta/permissions.js";
/**
 * interaction 统一分发器：按 button_data 的顶层 `t` 判别字段，路由到对应
 * channel（question / approval）。QQ 只有一个 interaction 入口，集中路由
 * 避免多通道各自 try 导致误判。
 */
function dispatchInteraction(event, manager) {
    const raw = event.data?.resolved?.button_data;
    if (!raw)
        return false;
    const button = decodeButtonData(raw);
    if (!button)
        return false;
    if (button.t === 'question')
        return manager.questionChannel?.handleInteraction(event) ?? false;
    if (button.t === 'approval')
        return manager.approvalChannel?.handleInteraction(event) ?? false;
    return false;
}
export async function bootstrapGateway(ctx, agents, config, logger, zeta) {
    const manager = new SessionManager(ctx, agents, config, logger);
    const groupInbox = new GroupInbox(() => zeta?.state.settings.group ?? { waitMs: 2000, maxWaitMs: 6000 }, async (batch, signal) => {
        const abort = () => { for (const item of batch)
            item.abort('group:cancelled'); };
        signal.addEventListener('abort', abort, { once: true });
        const watchdog = config.processingTimeoutMs > 0 ? setTimeout(() => { for (const item of batch)
            item.abort('group:processing-timeout'); }, config.processingTimeoutMs) : undefined;
        try {
            const requests = splitRequestBatches(batch, item => item.message.senderId, senderId => zeta?.isAdministrator(senderId) ?? false);
            const excludeIds = new Set(batch.map(item => item.message.messageId));
            for (const [index, request] of requests.entries()) {
                if (signal.aborted)
                    break;
                if (request[0] && !request.some(item => item.signal.aborted))
                    await handleInbound(request[0], manager, config, logger, zeta, request, { excludeIds, include: index === 0 });
            }
        }
        finally {
            signal.removeEventListener('abort', abort);
            if (watchdog)
                clearTimeout(watchdog);
        }
    }, error => logger.error(`Group batch failed: ${error instanceof Error ? error.message : String(error)}`), config.maxQueue);
    const privateInbox = new GroupInbox(() => ({ waitMs: 0, maxWaitMs: 0 }), async (batch, signal) => {
        const abort = () => { for (const item of batch)
            item.abort('private:cancelled'); };
        signal.addEventListener('abort', abort, { once: true });
        const watchdog = config.processingTimeoutMs > 0 ? setTimeout(() => { for (const item of batch)
            item.abort('private:processing-timeout'); }, config.processingTimeoutMs) : undefined;
        try {
            if (!signal.aborted && batch[0])
                await handleInbound(batch[0], manager, config, logger, zeta, batch);
        }
        finally {
            signal.removeEventListener('abort', abort);
            if (watchdog)
                clearTimeout(watchdog);
        }
    }, error => logger.error(`Private batch failed: ${error instanceof Error ? error.message : String(error)}`), config.maxQueue);
    zeta?.configureAccess(config.access);
    zeta?.configureQQ(config);
    // ── 初始化 QQ Bot SDK ──
    const userAgent = buildUserAgent();
    const bot = new QQBot({
        appId: config.appId,
        appSecret: config.appSecret,
        transport: 'websocket',
        baseUrl: process.env.QQBOT_BASE_URL?.replace(/\/+$/, '') || 'https://api.bot.qq.com',
        tokenBaseUrl: process.env.QQBOT_TOKEN_BASE_URL?.replace(/\/+$/, '') || 'https://api.bot.qq.com',
        userAgent,
        logger,
    });
    logger.info(`QQBot SDK initialized (UA: ${userAgent})`);
    // ── 中间件链 ──
    setupMiddlewares(bot, config, manager, logger, zeta, (scope, peerId) => {
        if (scope === 'group')
            groupInbox.cancel(peerId);
        else
            privateInbox.cancel(peerId);
        const record = manager.getSessionRecord(scope, peerId);
        record?.abortRequest?.();
        if (record)
            outbound.cancel(record.sessionId);
    });
    if (zeta) {
        try {
            bot.on('rawEvent', async (event) => {
                try {
                    await zeta.waitForMaintenance();
                    await observeGroupLifecycle(config.appId, zeta.state, event, config.access);
                }
                catch {
                    logger.warn('群会话状态更新失败。');
                }
            });
        }
        catch {
            logger.warn('当前QQ SDK不提供群状态事件，会话仍可通过收到的消息发现。');
        }
    }
    // ── 入站：经过中间件链后的消息交给 dsh agent ──
    bot.on('message', async (mCtx) => {
        const msg = mCtx.message;
        // 记录最近 msgId，供无上下文的出站发送（文件发送显式 target、主动推送等）获取被动回复目标
        if (!zeta)
            cacheMsgId(mCtx.replyTarget.scope, mCtx.replyTarget.targetId, mCtx.replyTarget.msgId);
        if (config.debug) {
            logger.debug(`← message (post-middleware): ${JSON.stringify(msg, null, 2).slice(0, 500)}`);
        }
        if (msg.kind === 'group')
            await groupInbox.enqueue(msg.groupOpenid ?? msg.senderId, mCtx);
        else
            await privateInbox.enqueue(msg.senderId, mCtx);
    });
    // ── 出站：dsh session/event → QQ 消息 ──
    // 获取 tools 服务（工具结果结构化展示），可选
    let toolsRegistry;
    try {
        toolsRegistry = ctx.get('tools');
    }
    catch {
        toolsRegistry = undefined;
    }
    // 发送适配器：将 QQBot 实例适配为 QQBotSender（openStream 参数形态不同）。
    // sendMarkdown 统一做被动回复限额管控：同一 msgId 超限/过期时降级主动推送。
    const replyLimiter = new ReplyLimiter({ limit: 4 });
    const sender = {
        sendMarkdown: (target, content, opts) => sendResolvedMarkdown(bot, resolveReplyTarget(target, replyLimiter, true), content, opts),
        openStream: (target) => bot.openStream({
            target: {
                scope: target.scope,
                targetId: target.targetId,
                msgId: target.msgId,
            },
        }),
    };
    // ── 附件发送适配器（qqbot_send_file 工具与交付物投递共用） ──
    // 包装 bot：让文件发送也走 msgId 兜底 + 被动回复限额管控。
    // 注意：SDK 文件发送暂不支持 event_id，故 allowEvent=false，跳过 event 候选。
    const mediaSender = {
        sendImage: (target, source) => bot.sendImage(resolveReplyTarget(target, replyLimiter, false), source),
        sendVideo: (target, source) => bot.sendVideo(resolveReplyTarget(target, replyLimiter, false), source),
        sendVoice: (target, source) => bot.sendVoice(resolveReplyTarget(target, replyLimiter, false), source),
        sendFile: (target, source, opts) => bot.sendFile(resolveReplyTarget(target, replyLimiter, false), source, opts),
    };
    zeta?.attachGateway({ manager, sender, mediaSender }, config.appId);
    // 交付物投递：present 声明的文件在轮末发送到当前会话（outbound 路由触发）
    const deliverablesDeliverer = new DeliverablesDeliverer(sender, mediaSender, config, logger, zeta);
    const outbound = createOutboundHandler(manager, sender, config, logger, toolsRegistry, deliverablesDeliverer, record => record.replyTarget.scope !== 'group', zeta ? {
        noteDelivered: (record, text) => zeta.noteReplyDelivered(record.agent, undefined, text, record.requestHandle),
        hasReplyDelivered: record => zeta.hasReplyDelivered(record.agent),
        hasDeliveredText: (record, text) => zeta.hasDeliveredText(record.agent, text),
    } : undefined);
    manager.waitForReplies = outbound.awaitText;
    ctx
        .on('session/event', outbound.routeSessionEvent);
    // Tool guards run after this waterfall. Wait for a committed AI preamble's
    // real QQ receipt before checking whether long work has been acknowledged.
    ctx.on('tools/pre-execute', async (exec, next) => {
        const agent = exec.agent;
        const id = agent?.session?.id ?? agent?.id;
        if (id && manager.findBySessionId(id))
            await outbound.awaitText(id, exec.signal);
        return next();
    }, { global: true });
    // ── 出站流式：agent/assistant-stream → 流式帧路由 ──
    // 实时流式走瞬态 agent/assistant-stream（chunk 不进 session log）。
    // 该事件按 agent 作用域派发，根作用域监听器不带 global 会被过滤（同
    // approval/request），帧到达后自行按 agent.id 路由，非 QQ 会话在 router 内忽略。
    ctx
        .on('agent/assistant-stream', (payload) => {
        const parsed = parseStreamFrame(payload);
        if (parsed !== undefined)
            outbound.routeStreamFrame(parsed.agentId, parsed.delta);
    }, { global: true });
    // ── 问答通道（ask_user_question → QQ 文本 + 按钮） ──
    const questionChannel = new QuestionChannel(manager, sender, config, logger);
    manager.questionChannel = questionChannel;
    questionChannel.install(ctx);
    // ── 审批通道（approval/request → QQ 两按钮审批） ──
    const approvalChannel = new ApprovalChannel(manager, sender, logger, {
        canRequest: request => zeta?.canApprove(request.agent) ?? false,
        canApprove: (request, event) => {
            const senderId = event.group_openid ? event.group_member_openid ?? event.user_openid : event.user_openid;
            return !!senderId && (zeta?.canApprove(request.agent, senderId) ?? false);
        },
    });
    manager.approvalChannel = approvalChannel;
    approvalChannel.install(ctx);
    // ── 按钮点击回调（interaction）：统一分发到问答/审批通道 ──
    bot.on('interaction', async (_iCtx, event) => {
        // scope/targetId 推导对齐消息事件（inbound.ts）：按 scene 判定类型，群用 group_openid，私聊用 user_openid
        const scope = event.scene === 'group' ? 'group' : 'c2c';
        const targetId = scope === 'group' ? (event.group_openid ?? event.user_openid) : event.user_openid;
        // 记录互动事件 id，作为后续被动回复候选（event_id）
        cacheEventId(scope, targetId, event.id);
        const matched = dispatchInteraction(event, manager);
        await bot.acknowledgeInteraction(event.id, matched ? 0 : 3).catch(() => { });
    });
    bot.on('error', (err) => {
        logger.error(`bot error: ${err instanceof Error ? err.message : String(err)}`);
    });
    // 掉线可观测：willReconnect=false 表示不会再重连（随后 bot.start() 的 Promise 会失败）。
    // disconnected 事件为 SDK 1.0.5+ 新增：旧版 handlers 表缺该键，bot.on 会抛
    // TypeError（profiles 增量安装可能残留旧版 SDK）——降级为跳过监听而非崩溃
    try {
        bot.on('disconnected', (event) => {
            const detail = `code=${event.code}${event.reason ? ` reason=${event.reason}` : ''}`;
            if (event.willReconnect) {
                logger.warn(`Bot disconnected (${detail}), reconnecting...`);
            }
            else {
                logger.error(`Bot disconnected permanently (${detail}), giving up`);
            }
        });
    }
    catch (err) {
        logger.warn(`qqbot-nodejs SDK 不支持 disconnected 事件（请升级 @tencent-connect/qqbot-nodejs 至 1.0.5+）: ${err instanceof Error ? err.message : String(err)}`);
    }
    bot.on('ready', () => {
        console.log(`[im-qqbot] Bot ready! appId=${config.appId}`);
    });
    // ── 富媒体过期清理 ──
    if (config.media.enabled) {
        startMediaCleanup(ctx, config.media.ttlHours, logger);
    }
    // ── 视觉工具注册（qqbot_describe_image，复用 dsh llm + attachments） ──
    ensureVisionInputModal(config.vision, logger);
    registerDescribeImageTool(ctx, config.vision, logger);
    // ── 附件发送工具注册（qqbot_send_file，发送器见上方 mediaSender） ──
    zeta?.configureFileRoots([config.cwd || process.cwd(), ...config.sendFile.extraRoots]);
    registerSendFileTool(ctx, mediaSender, manager, config, logger, zeta);
    // ── 生命周期 ──
    ctx
        .effect(() => {
        logger.info(`Starting bot (appId=${config.appId})`);
        bot.start().catch((err) => {
            logger.error(`Bot start failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        return async () => {
            logger.info('Shutting down');
            groupInbox.dispose();
            privateInbox.dispose();
            approvalChannel.uninstall();
            questionChannel.uninstall();
            await manager.disposeAll();
            bot.stop();
        };
    }, 'im-qqbot.lifecycle');
}
//# sourceMappingURL=bootstrap.js.map