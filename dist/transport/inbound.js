import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { classifyContentType, isVoiceContentType, } from "./attachment.js";
import { clearGroupHistory } from "../features/history-store.js";
// ── 主处理函数 ──
/**
 * 处理 QQ 入站消息（已经过 SDK 中间件链）
 */
export async function handleInbound(ctx, manager, config, logger, zeta, batch = [ctx], history = {}) {
    await zeta?.waitForMaintenance();
    const msg = ctx.message;
    const { bot } = ctx;
    const scope = msg.kind === 'group' ? 'group' : 'c2c';
    const peerId = scope === 'group' ? (msg.groupOpenid ?? msg.senderId) : msg.senderId;
    const replyTarget = {
        scope,
        targetId: peerId,
        msgId: msg.messageId,
    };
    // ── 组装 agentBody（下载结果经 mwState.downloadedFiles 提供） ──
    const messages = batch.map(item => ({ message: item.message, state: item.state }));
    const batchIds = new Set([...history.excludeIds ?? [], ...messages.map(item => item.message.messageId)]);
    const agentBody = messages.map(({ message, state }, index) => {
        const filtered = { ...state, history: index === 0 && history.include !== false ? state.history?.filter(entry => !batchIds.has(entry.messageId)) : [] };
        const body = assembleAgentBody(message, filtered, scope, logger);
        return body && scope === 'group' ? `[消息 ${message.messageId} · ${message.timestamp}]\n${body}` : body;
    }).filter(Boolean).join('\n\n');
    if (!agentBody)
        return;
    logger.info(`Processing: scope=${scope} peerId=${peerId} body="${agentBody.slice(0, 200)}"`);
    // ── 获取或创建会话 ──
    let record;
    try {
        record = await manager.getOrCreate(scope, peerId, msg.senderId, replyTarget);
        if (zeta) {
            await zeta.bindRecord(record);
            zeta.noteAttachments(record.agent, messages.flatMap(item => [...(item.state.downloadedFiles ?? []), ...(item.state.downloadedQuoteFiles ?? [])]).map(file => file.localPath));
            zeta.beginRequest(record.agent, messages.map(item => ({ senderId: item.message.senderId, messageId: item.message.messageId, text: item.message.content })), scope === 'group');
        }
    }
    catch (err) {
        logger.error(`ERROR creating session: ${err instanceof Error ? err.message : String(err)}`);
        // 兜底回复：会话创建失败时告知用户，避免静默无响应
        if (scope !== 'group') {
            try {
                await bot.sendMarkdown(replyTarget, '⚠️ 处理消息时出现异常，请稍后重试。');
            }
            catch (sendErr) {
                logger.error(`fallback reply failed: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`);
            }
        }
        return;
    }
    // ── 构建 UserMessage → followup ──
    const content = [{ type: 'text', text: agentBody }];
    const message = createUserMessage({
        content,
        source: { kind: 'user' },
    });
    const abort = () => { record.agent.cancel({ kind: 'user' }); };
    for (const item of batch)
        item.signal.addEventListener('abort', abort, { once: true });
    if (batch.some(item => item.signal.aborted)) {
        for (const item of batch)
            item.signal.removeEventListener('abort', abort);
        zeta?.endRequest(record.agent);
        return;
    }
    // 阻塞等待本轮 turn 收敛，避免后续消息在 turn 运行期间被 followup 打断
    try {
        record.agent.followup(message);
        logger.info(`→ followup sent: key=${scope}:${peerId}`);
        if (scope === 'group') {
            clearGroupHistory(config.appId, msg.groupOpenid ?? msg.senderId);
            await zeta?.state.consumeMigrationGroup(config.appId, msg.groupOpenid ?? msg.senderId);
        }
        await record.agent.whenIdle();
    }
    catch (err) {
        logger.warn(`whenIdle rejected: ${err instanceof Error ? err.message : String(err)}`);
    }
    finally {
        for (const item of batch)
            item.signal.removeEventListener('abort', abort);
        zeta?.endRequest(record.agent);
    }
}
// ══════════════════════════════════════════════════════════════
// Body Assembly（5 层组装）
// ══════════════════════════════════════════════════════════════
/**
 * 组装 agentBody — AI 实际看到的完整上下文
 */
function assembleAgentBody(msg, state, scope, logger) {
    const isGroup = scope === 'group';
    const wasMentioned = state.mention?.wasMentioned ?? false;
    const userContent = buildUserContent(msg, state, logger);
    if (isEmptyMessage(userContent, msg.attachments, isGroup, wasMentioned))
        return null;
    const quotePart = buildQuotePart(state.quote);
    const userMessage = buildUserMessage(userContent, quotePart, msg.senderId, msg.senderName, isGroup, wasMentioned);
    const dynamicCtx = buildDynamicCtx(msg, state);
    const base = dynamicCtx ? `${dynamicCtx}${userMessage}` : userMessage;
    const agentBody = buildAgentBody(base, state.history, isGroup, wasMentioned);
    return agentBody;
}
/**
 * 判断消息是否为空：无文本/语音/附件，且非群聊 @。
 * 群聊被 @ 视为有效触发信号，即使内容为空也保留给 agent。
 */
function isEmptyMessage(userContent, attachments, isGroup, wasMentioned) {
    if (userContent)
        return false;
    if (attachments && attachments.length > 0)
        return false;
    if (isGroup && wasMentioned)
        return false;
    return true;
}
/**
 * Layer 1: 用户文本内容 + 语音转录 + 附件类型标签（媒体路径由 buildDynamicCtx 提供）
 */
function buildUserContent(msg, state, logger) {
    const parts = [];
    const text = (msg.content ?? '').trim();
    if (text) {
        parts.push(text);
    }
    const voiceTexts = extractVoiceTexts(msg.attachments, state.processedAttachments, logger);
    if (voiceTexts.length > 0) {
        for (const vt of voiceTexts) {
            const durationTag = vt.duration ? ` (${vt.duration}s)` : '';
            parts.push(`[Voice message${durationTag}] ${vt.text}`);
        }
    }
    // 附件类型标签（媒体路径由 buildDynamicCtx 提供，这里只提示「带了什么」）
    const attachmentTags = buildAttachmentTags(msg.attachments);
    if (attachmentTags) {
        parts.push(attachmentTags);
    }
    return parts.join('\n');
}
/**
 * Layer 2: 引用消息块
 */
function buildQuotePart(quote) {
    if (!quote?.text && !quote?.entry?.content)
        return '';
    const quoteText = quote.text || quote.entry?.content || 'Original content unavailable';
    return `[Quoted message begins]\n${quoteText}\n[Quoted message ends]\n[Current message]\n`;
}
/**
 * Layer 3: 带发送者标签的用户消息
 */
function buildUserMessage(userContent, quotePart, senderId, senderName, isGroup, wasMentioned) {
    if (!isGroup) {
        return `${quotePart}${userContent}`;
    }
    const mentionTag = wasMentioned ? ' (@you)' : '';
    const displayName = senderName ?? shortSenderId(senderId);
    const senderTag = `[${displayName} (${senderId})]`;
    return `${quotePart}${senderTag} ${userContent}${mentionTag}`;
}
/**
 * Layer 4: 媒体元数据上下文（图片/视频/文件本地路径 + 语音 ASR + 引用附件）
 */
function buildDynamicCtx(msg, state) {
    const lines = [];
    if (msg.attachments && msg.attachments.length > 0) {
        const downloadedByFilename = new Map((state.downloadedFiles ?? []).map(d => [d.filename, d]));
        const voices = [];
        // 一次遍历归类 + 生成媒体行
        for (const att of msg.attachments) {
            const kind = classifyContentType(att.content_type);
            if (kind === 'voice') {
                voices.push(att);
                continue;
            }
            const d = downloadedByFilename.get(att.filename);
            lines.push(`- ${renderMediaLine(kind, att.filename, d?.localPath, att.url, att.size)}`);
        }
        // 语音：有 ASR 文本才带文本，否则只带链接（纯文本模型无法消费音频）
        if (voices.length > 0) {
            const asrTexts = voices.map(a => a.asr_refer_text).filter(Boolean);
            if (asrTexts.length > 0) {
                lines.push(`- ASR: ${asrTexts.join(' | ')}`);
            }
            else {
                const urls = voices.map(a => a.url).filter(Boolean);
                if (urls.length > 0)
                    lines.push(`- Voice: ${urls.join(', ')}`);
            }
        }
    }
    // 引用消息的附件（独立于当前消息媒体，不受上一步为空影响）
    const quoteAttachments = state.quote?.attachments;
    if (quoteAttachments && quoteAttachments.length > 0) {
        const downloadedQuote = new Map((state.downloadedQuoteFiles ?? []).map(d => [d.filename, d]));
        lines.push('[Reference attachments]');
        for (const qa of quoteAttachments) {
            const kind = classifyContentType(qa.contentType);
            const d = downloadedQuote.get(qa.filename ?? '');
            if (kind === 'voice') {
                if (qa.asrText)
                    lines.push(`  - Voice: ${qa.asrText}`);
                continue;
            }
            lines.push(`  - ${renderMediaLine(kind, qa.filename, d?.localPath, qa.url, undefined)}`);
        }
    }
    return lines.length > 0 ? lines.join('\n') + '\n\n' : '';
}
/**
 * 渲染单个媒体附件（image/video/file）的上下文行内容，不含列表前缀。
 * 当前消息与引用消息共用，保证附件格式统一。语音不在此处理（见 buildDynamicCtx）。
 */
function renderMediaLine(kind, filename, localPath, url, size) {
    switch (kind) {
        case 'image':
            return localPath
                ? `Image: ${localPath}`
                : `Image: ${url ?? filename ?? 'image'}`;
        case 'video':
            return localPath
                ? `Video: ${localPath}`
                : `Video: ${filename ?? 'video'} (download failed)`;
        case 'file':
            return localPath
                ? `File: ${localPath}`
                : `File: ${filename ?? 'file'} (${formatFileSize(size ?? 0)})`;
    }
}
/**
 * Layer 5: 最终 agentBody 拼合
 */
function buildAgentBody(base, history, isGroup, _wasMentioned) {
    if (!isGroup || !history || history.length === 0) {
        return base;
    }
    const historyLines = history.map(h => {
        const name = h.senderName ?? shortSenderId(h.senderId);
        return `[${name} (${h.senderId})] ${h.content}`;
    });
    return [
        '[Chat history begins]',
        ...historyLines,
        '',
        '[Chat history ends]',
        '[Current message]',
        base,
    ].join('\n');
}
function extractVoiceTexts(attachments, processed, _logger) {
    const results = [];
    if (processed) {
        for (const pa of processed) {
            if (pa.type === 'voice' && pa.voiceText) {
                results.push({
                    text: pa.voiceText,
                    duration: pa.duration,
                    source: pa.voiceSource ?? 'stt',
                });
            }
        }
    }
    if (results.length === 0 && attachments) {
        for (const att of attachments) {
            if (isVoiceContentType(att.content_type) && att.asr_refer_text) {
                results.push({
                    text: att.asr_refer_text.trim(),
                    source: 'asr',
                });
            }
        }
    }
    return results;
}
/**
 * 附件类型标签（Layer 1 用户消息主体里的轻量提示）。
 * 只标注「带了什么类型的附件」，去重；媒体本地路径在 buildDynamicCtx 提供。
 */
function buildAttachmentTags(attachments) {
    if (!attachments || attachments.length === 0)
        return '';
    const labels = {
        image: '[图片]',
        video: '[视频]',
        file: '[文件]',
    };
    const seen = new Set();
    const tags = [];
    for (const att of attachments) {
        const kind = classifyContentType(att.content_type);
        if (kind === 'voice' || seen.has(kind))
            continue;
        seen.add(kind);
        const label = labels[kind];
        if (label)
            tags.push(label);
    }
    return tags.join(' ');
}
function formatFileSize(bytes) {
    if (bytes < 1024)
        return `${bytes}B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
/** 发送者短标识长度（openid 前 N 位，无昵称时兜底） */
const SENDER_SHORT_ID_LEN = 8;
/** 无昵称时用 openid 前 N 位作为匿名标识 */
function shortSenderId(senderId) {
    return senderId.slice(0, SENDER_SHORT_ID_LEN);
}
//# sourceMappingURL=inbound.js.map