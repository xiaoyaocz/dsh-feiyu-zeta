import { chunkMarkdownText } from "./chunker.js";
import { OutboundBuffer } from "./outbound-buffer.js";
import { formatToolResult } from "./tool-presenter.js";
import { parseEvent, extractTurnError, } from "./events.js";
export { parseStreamFrame } from "./events.js";
/** 不展示给用户的轮次错误码（底层传输/网络错误，对用户无意义，且常被重试兜住） */
const SILENT_TURN_ERROR_CODES = new Set(['STREAM_CLOSED']);
/**
 * 出站路由器：持有会话级状态，按事件类型分发到处理器
 */
class OutboundRouter {
    buffers = new Map();
    toolCalls = new Map();
    /** 每会话当前流式 attemptId：LLM 重试会发布新 attempt，用于 reset 与迟到帧过滤 */
    streamAttempts = new Map();
    /** 每会话本轮已声明的交付文件（deliverables/presented，轮末清空） */
    presentedFiles = new Map();
    /** 每会话已见过的 present callId（轮内去重，防事件重放导致重复投递） */
    presentedCalls = new Map();
    /**
     * 每会话最后一笔在途文本发送（assistant/message 的 flush 是 fire-and-forget，
     * turn/end 时需等待其完成再投递交付文件，保证回复文本先于文件到达用户）。
     */
    pendingText = new Map();
    manager;
    bot;
    config;
    logger;
    toolsRegistry;
    deliverer;
    allowAutomatic;
    replyPolicy;
    constructor(manager, bot, config, logger, toolsRegistry, deliverer, allowAutomatic = () => true, replyPolicy) {
        this.manager = manager;
        this.bot = bot;
        this.config = config;
        this.logger = logger;
        this.toolsRegistry = toolsRegistry;
        this.deliverer = deliverer;
        this.allowAutomatic = allowAutomatic;
        this.replyPolicy = replyPolicy;
    }
    cancel(sessionId) {
        this.buffers.get(sessionId)?.cancel();
        this.buffers.delete(sessionId);
        this.streamAttempts.delete(sessionId);
        this.presentedFiles.delete(sessionId);
        this.presentedCalls.delete(sessionId);
        this.pendingText.delete(sessionId);
        for (const key of this.toolCalls.keys())
            if (key.startsWith(`${sessionId}:`))
                this.toolCalls.delete(key);
    }
    async awaitText(sessionId, signal) {
        let previous;
        for (;;) {
            signal?.throwIfAborted();
            const pending = this.pendingText.get(sessionId);
            if (!pending || pending === previous)
                return;
            previous = pending;
            if (!signal) {
                await pending;
                continue;
            }
            let abort;
            try {
                await Promise.race([pending, new Promise((_resolve, reject) => {
                        abort = () => reject(signal.reason);
                        signal.addEventListener('abort', abort, { once: true });
                        if (signal.aborted)
                            abort();
                    })]);
            }
            finally {
                signal.removeEventListener('abort', abort);
            }
        }
    }
    /** 事件分发入口 */
    route(session, raw) {
        const event = parseEvent(raw);
        if (event === undefined)
            return;
        const record = this.manager.findBySessionId(session.header.id);
        if (record === undefined)
            return;
        if (record.requestSignal?.aborted || (event.type === 'turn/end' && event.reason.kind === 'interrupted')) {
            this.cancel(session.header.id);
            return;
        }
        if (!this.allowAutomatic(record))
            return;
        switch (event.type) {
            case 'assistant/chunk':
                this.onChunk(session.header.id, record, event);
                break;
            case 'assistant/message':
                this.onMessage(session.header.id, record, event);
                break;
            case 'tool/call':
                this.onToolCall(session.header.id, event);
                break;
            case 'tool/result':
                this.onToolResult(session.header.id, record, event);
                break;
            case 'deliverables/presented':
                this.onPresented(session.header.id, event);
                break;
            case 'turn/end':
                this.onTurnEnd(session.header.id, record, event);
                break;
        }
    }
    /** durable assistant/chunk 事件的流式增量（历史格式兼容保留，当前宿主不再生产该事件） */
    onChunk(sessionId, record, event) {
        this.appendChunk(sessionId, record, event.text);
    }
    /**
     * 实时流式帧入口（瞬态 agent/assistant-stream 事件）。
     *
     * attempt 语义：start 帧即新内容起点，无条件重置 buffer——清空旧 attempt 的
     * 累积文本但保留流式会话（QQ 流式 update 是全量替换，用户看到同一条消息被
     * 新内容重写）。不用 attemptId 对比判断"新 attempt"：agent replacement 后
     * attempt 计数重启、attemptId 可能与旧 agent 重叠（官方按 frame revision 的
     * gap 检测处理同一问题）。迟到帧（attemptId 不匹配）仍直接丢弃，防止旧
     * attempt 的尾巴混进新内容。
     */
    routeStreamFrame(agentId, delta) {
        const record = this.manager.findBySessionId(agentId);
        if (record === undefined)
            return;
        if (record.requestSignal?.aborted) {
            this.cancel(agentId);
            return;
        }
        if (!this.allowAutomatic(record))
            return;
        if (delta.kind === 'attempt-start') {
            this.streamAttempts.set(agentId, delta.attemptId);
            this.buffers.get(agentId)?.reset();
            return;
        }
        // text-delta：首帧未见 start 时自愈记录，迟到帧丢弃
        const current = this.streamAttempts.get(agentId);
        if (current === undefined) {
            this.streamAttempts.set(agentId, delta.attemptId);
        }
        else if (current !== delta.attemptId) {
            return;
        }
        this.appendChunk(agentId, record, delta.text);
    }
    /** 获取或创建会话 buffer 并追加增量 */
    appendChunk(sessionId, record, text) {
        let buffer = this.buffers.get(sessionId);
        if (buffer === undefined) {
            const snapshot = { ...record, replyTarget: { ...record.replyTarget } };
            buffer = new OutboundBuffer(snapshot, this.bot, this.config.textChunkLimit, this.logger, this.shouldStream(record), {
                signal: snapshot.requestSignal, onDelivered: text => this.replyPolicy?.noteDelivered(snapshot, text),
            });
            this.buffers.set(sessionId, buffer);
        }
        buffer.append(text);
    }
    /** 是否启用流式：配置开启 + c2c + 有 msgId（群聊不支持流式） */
    shouldStream(record) {
        return this.config.streaming
            && record.replyTarget.scope === 'c2c'
            && !!record.replyTarget.msgId
            // Subsequent stages remain visible at message commit, when their full
            // text can be compared with an explicit tool reply before sending.
            && !this.replyPolicy?.hasReplyDelivered(record);
    }
    /** 完整 assistant 消息：有流式 buffer 则 flush，否则直接发送文本块 */
    onMessage(sessionId, record, event) {
        const fullText = event.content.filter(block => block.type === 'text' && block.text).map(block => block.text).join('\n');
        const buffer = this.buffers.get(sessionId);
        if (fullText.trim() && this.replyPolicy?.hasDeliveredText(record, fullText)) {
            buffer?.cancel();
            this.buffers.delete(sessionId);
            return;
        }
        if (buffer !== undefined && buffer.text.trim()) {
            this.trackText(sessionId, () => buffer.flush());
            this.buffers.delete(sessionId);
            return;
        }
        if (!fullText.trim())
            return;
        const snapshot = { ...record, replyTarget: { ...record.replyTarget } };
        this.trackText(sessionId, () => this.replyPolicy?.hasDeliveredText(snapshot, fullText) ? Promise.resolve() : this.send(snapshot, fullText, 'sendMarkdown'));
        this.buffers.delete(sessionId);
    }
    /** 记录每会话最后一笔在途文本任务（自身吞错：错误已由 send/flush 内部记录） */
    trackText(sessionId, task) {
        const pending = (this.pendingText.get(sessionId) ?? Promise.resolve()).then(task).catch(error => {
            this.logger.error(`im-qqbot: reply delivery failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        this.pendingText.set(sessionId, pending);
        return pending;
    }
    /** 工具调用：仅记录，不发送（避免刷屏，等待结果） */
    onToolCall(sessionId, event) {
        this.toolCalls.set(`${sessionId}:${event.callId}`, { name: event.name, args: event.arguments });
    }
    /** Zeta models explain tool outcomes themselves; diagnostics remain opt-in. */
    onToolResult(sessionId, record, event) {
        const call = this.toolCalls.get(`${sessionId}:${event.callId}`);
        this.toolCalls.delete(`${sessionId}:${event.callId}`);
        if (call === undefined)
            return;
        if (!this.config.showToolResults && (event.error === undefined || this.replyPolicy)) {
            if (event.error)
                this.logger.warn(`im-qqbot: tool result retained for AI: ${call.name} (${event.error.name}: ${event.error.code})`);
            return;
        }
        const text = formatToolResult(call.name, call.args, event.raw, this.toolsRegistry, record.agent);
        if (!text)
            return;
        void this.send(record, text, 'sendToolResult');
    }
    /** 收集本轮声明的交付文件：事件总是先于 turn/end 到达，轮末统一投递 */
    onPresented(sessionId, event) {
        if (this.config.sendFile?.sendPresentedFiles === false)
            return;
        let calls = this.presentedCalls.get(sessionId);
        if (calls === undefined) {
            calls = new Set();
            this.presentedCalls.set(sessionId, calls);
        }
        if (calls.has(event.callId))
            return;
        calls.add(event.callId);
        const files = this.presentedFiles.get(sessionId) ?? [];
        files.push(...event.files);
        this.presentedFiles.set(sessionId, files);
    }
    /**
     * 轮次结束：文本先送达、再投递交付文件、最后清理状态，异常结束时告知用户。
     * 外层轮次失败不撤销已完成的声明（宿主契约），故失败轮的文件仍投递。
     */
    onTurnEnd(sessionId, record, event) {
        const buffer = this.buffers.get(sessionId);
        // 文本 flush 可等待，保证回复先于交付文件到达用户
        this.buffers.delete(sessionId);
        this.streamAttempts.delete(sessionId);
        const files = this.presentedFiles.get(sessionId) ?? [];
        this.presentedFiles.delete(sessionId);
        this.presentedCalls.delete(sessionId);
        // assistant/message 已在轮内先行发送的文本可能仍在途：与 turn/end 自身的 flush 一起等待
        const failure = extractTurnError(event.reason);
        const snapshot = { ...record, replyTarget: { ...record.replyTarget } };
        const task = this.trackText(sessionId, async () => {
            if (snapshot.requestSignal?.aborted) {
                buffer?.cancel();
                return;
            }
            if (buffer?.text.trim())
                await buffer.flush();
            else
                buffer?.cancel();
            if (snapshot.requestSignal?.aborted)
                return;
            if (failure !== undefined && !SILENT_TURN_ERROR_CODES.has(failure.code)) {
                await this.send(snapshot, `⚠️ 本轮异常结束\n\`${failure.code}\`: ${failure.message}`, 'sendTurnEndError');
            }
            if (!snapshot.requestSignal?.aborted && files.length > 0 && this.deliverer !== undefined) {
                await this.deliverer.deliver(snapshot, files);
            }
            this.logger.debug(`im-qqbot: turn/end sessionId=${sessionId}`);
        });
        void task.finally(() => { if (this.pendingText.get(sessionId) === task)
            this.pendingText.delete(sessionId); });
    }
    /** 统一发送：切分 + 逐 chunk 发送 + 错误记录 */
    async send(record, text, tag) {
        record = { ...record, replyTarget: { ...record.replyTarget } };
        const chunks = chunkMarkdownText(text, this.config.textChunkLimit);
        let complete = true;
        for (const chunk of chunks) {
            if (record.requestSignal?.aborted)
                return;
            try {
                await this.bot.sendMarkdown(record.replyTarget, chunk);
                if (record.requestSignal?.aborted)
                    return;
                if (tag === 'sendMarkdown')
                    this.replyPolicy?.noteDelivered(record, chunk);
            }
            catch (err) {
                complete = false;
                this.logger.error(`im-qqbot: ${tag} failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        if (complete && tag === 'sendMarkdown')
            this.replyPolicy?.noteDelivered(record, text);
    }
}
/**
 * 创建出站事件处理器
 *
 * 返回 durable 事件与实时流式帧两个入口，分别注册到
 * ctx.on('session/event') 与 ctx.on('agent/assistant-stream', ..., { global: true })。
 * toolsRegistry 用于工具结果的结构化展示；deliverer 用于轮末投递 present 声明的交付文件。
 */
export function createOutboundHandler(manager, bot, config, logger, toolsRegistry, deliverer, allowAutomatic, replyPolicy) {
    const router = new OutboundRouter(manager, bot, config, logger, toolsRegistry, deliverer, allowAutomatic, replyPolicy);
    return {
        routeSessionEvent: (session, event) => router.route(session, event),
        routeStreamFrame: (agentId, delta) => router.routeStreamFrame(agentId, delta),
        cancel: sessionId => router.cancel(sessionId),
        awaitText: (sessionId, signal) => router.awaitText(sessionId, signal),
    };
}
//# sourceMappingURL=outbound.js.map