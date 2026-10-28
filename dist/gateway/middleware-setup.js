import { errorHandler, messageFilter, accessPolicy, mentionGate, contentSanitizer, rateLimiter, slashCommand, typingIndicator, quoteRef, historyBuffer, envelopeFormatter, } from '@tencent-connect/qqbot-nodejs';
import { buildCommandList } from "../commands/index.js";
import { attachmentProcessor } from "../middleware/attachment.js";
import { questionAnswer } from "../middleware/question-answer.js";
import { getHistoryStore, historyGroupKey } from "../features/history-store.js";
import { conversationDiscovery } from "../zeta/discovery.js";
import { naturalStop } from "../middleware/stop.js";
export function setupMiddlewares(bot, config, manager, logger, zeta, cancelQueued) {
    // 1. 错误兜底（最外层洋葱皮）
    bot.use(errorHandler());
    // 2. 消息过滤：bot 回声 + 消息去重
    bot.use(messageFilter({ skipSelfEcho: true }));
    // 3. 访问控制（白名单/开放/禁用）
    bot.use(accessPolicy({
        c2c: {
            mode: config.access.c2cMode,
            allow: config.access.c2cAllow,
        },
        group: {
            mode: config.access.groupMode,
            allow: config.access.groupAllow,
        },
        onBlock: (_mCtx, reason) => {
            if (config.debug) {
                logger.debug(`Access blocked: ${reason}`);
            }
        },
    }));
    // Urgent cancellation must not wait for discovery, mention gates, rate
    // limits, attachment downloads or the conversation's normal request queue.
    bot.use(naturalStop(manager, cancelQueued));
    // Accepted messages reveal their QQ destination even when mention/command
    // middleware later stops them. Discovery never starts a model turn.
    if (zeta)
        bot.use(conversationDiscovery(config.appId, {
            observeConversation: async (observation) => { await zeta.waitForMaintenance(); return zeta.state.observeConversation(observation); },
            observeUser: async (observation) => { await zeta.waitForMaintenance(); return zeta.state.observeUser(observation); },
        }, logger));
    // 4. 群历史缓冲 — 放在门控之前，确保所有消息（含未 @bot）都计入上下文
    //    store 走共享单例（getHistoryStore），groupKey 带 appId 前缀，供回复后清空
    bot.use(historyBuffer({
        limit: config.historyLimit,
        store: getHistoryStore(),
        recordOnSkip: true,
        groupKey: (ctx) => {
            const gid = ctx.message.groupOpenid;
            if (ctx.message.kind !== 'group' || !gid)
                return undefined;
            return historyGroupKey(config.appId, gid);
        },
    }));
    // 5. 群聊 @bot 门控
    bot.use(mentionGate({
        requireMentionInGroup: config.requireMention,
    }));
    // 6. 内容清洗（去 @marker、表情标签、多余空白）
    bot.use(contentSanitizer({
        parseFaceTags: true,
    }));
    // 7. 三层限流（sender / group / global）
    bot.use(rateLimiter());
    // 8. 斜杠命令（在 concurrencyGuard 之前，命令匹配后不排队直接响应）
    const slash = slashCommand({
        // 关闭 autoHelp：help 命令由 qqbot 注册为 /bot-help，
        // 避免 SDK 再自动注册一个无前缀的 /help 造成重复
        autoHelp: false,
        commands: buildCommandList({ manager, config, cancelQueued, isAdministrator: senderId => zeta?.isAdministrator(senderId) ?? false }),
    });
    bot.use(slash.middleware);
    // 8.5. 待答问题截获（在 concurrencyGuard 之前，答案消息不排队直接作答）
    bot.use(questionAnswer(manager));
    // 9. Serial batching is owned by bootstrap's inboxes. Preserve each sender,
    // attachment and request identity rather than flattening SDK contexts.
    // 10. C2C 输入状态指示
    bot.use(typingIndicator());
    // 11. 引用消息解析（记录 + 解析被引用原文）
    bot.use(quoteRef({
        maxSize: 500,
        preferMsgElements: true,
    }));
    // 11.5. 附件下载（file 附件下载到本地，供 @提及 / 工具访问）
    bot.use(attachmentProcessor(config, logger));
    // 12. 上下文组装（将 history + quote + sender 组成 envelope）
    bot.use(envelopeFormatter({
        historyLimit: config.historyLimit,
        includeQuote: true,
        includeSender: true,
    }));
}
//# sourceMappingURL=middleware-setup.js.map