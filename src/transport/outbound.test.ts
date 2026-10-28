import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createOutboundHandler, type AutomaticReplyPolicy } from './outbound.ts';
import type { QQBotSender, StreamSessionLike } from './outbound-buffer.ts';
import type { SessionManager, SessionRecord } from '../session/index.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger, ReplyTarget } from '../types.ts';

function createLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createSession(): StreamSessionLike {
  return { update: vi.fn().mockResolvedValue(undefined), complete: vi.fn().mockResolvedValue({ id: 'stream1' }), cancel: vi.fn() };
}

function createBot(session: StreamSessionLike): QQBotSender {
  return {
    sendMarkdown: vi.fn().mockResolvedValue(undefined),
    openStream: vi.fn(() => session),
  };
}

const c2cTarget: ReplyTarget = { scope: 'c2c', targetId: 'user1', msgId: 'msg1' };
const groupTarget: ReplyTarget = { scope: 'group', targetId: 'group1', msgId: 'msg1' };

function createRecord(target: ReplyTarget, sessionId = 'sess-qq'): SessionRecord {
  return {
    sessionKey: 'k',
    sessionId,
    replyTarget: target,
    agent: {},
    handle: {},
    createdAt: 0,
    lastActiveAt: 0,
  } as unknown as SessionRecord;
}

function createConfig(overrides?: Partial<ImQQBotConfig>): ImQQBotConfig {
  return {
    streaming: true,
    textChunkLimit: 4500,
    showToolResults: false,
    ...overrides,
  } as unknown as ImQQBotConfig;
}

/** 组装 handler：manager 按 sessionId 返回 record（默认 c2c 私聊） */
function setup(opts?: {
  record?: SessionRecord | undefined;
  config?: ImQQBotConfig;
  deliverer?: { deliver: ReturnType<typeof vi.fn> };
  allowAutomatic?: (record: SessionRecord) => boolean;
  replyPolicy?: AutomaticReplyPolicy;
}) {
  const session = createSession();
  const bot = createBot(session);
  const record = 'record' in (opts ?? {}) ? opts!.record : createRecord(c2cTarget);
  const manager = {
    findBySessionId: vi.fn((id: string) => (id === 'sess-qq' ? record : undefined)),
  } as unknown as SessionManager;
  const outbound = createOutboundHandler(
    manager, bot, opts?.config ?? createConfig(), createLogger(), undefined, opts?.deliverer, opts?.allowAutomatic, opts?.replyPolicy,
  );
  return { outbound, bot, session };
}

const delta = (attemptId: string, text: string) => ({ kind: 'text-delta' as const, attemptId, text });
const start = (attemptId: string) => ({ kind: 'attempt-start' as const, attemptId });

describe('AI-written acknowledgement and progress delivery', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  function policy() {
    const text = new Set<string>();
    const replyPolicy: AutomaticReplyPolicy = { noteDelivered: vi.fn((_record, value) => { text.add(value.trim()); }),
      hasReplyDelivered: () => text.size > 0, hasDeliveredText: (_record, value) => text.has(value.trim()) };
    return { text, replyPolicy };
  }
  it('waits for the actual preamble receipt before acknowledging it to a long tool', async () => {
    const { replyPolicy } = policy(), { outbound, bot } = setup({ config: createConfig({ streaming: false }), replyPolicy });
    let receipt!: () => void; vi.mocked(bot.sendMarkdown).mockImplementation(() => new Promise<void>(resolve => { receipt = resolve; }));
    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我先整理资料，再做这个页面。' }, { type: 'tool-call', name: 'zeta_deploy_page' }] } } });
    let ready = false; const gate = outbound.awaitText('sess-qq').then(() => { ready = true; });
    await Promise.resolve(); expect(bot.sendMarkdown).toHaveBeenCalledWith(c2cTarget, '我先整理资料，再做这个页面。'); expect(ready).toBe(false); expect(replyPolicy.hasReplyDelivered({} as SessionRecord)).toBe(false);
    receipt(); await gate; expect(ready).toBe(true); expect(replyPolicy.hasReplyDelivered({} as SessionRecord)).toBe(true);
  });
  it('keeps the acknowledgement gate closed when only a prior attempt obtained a stream receipt', async () => {
    const { replyPolicy, text } = policy(), { outbound, bot, session } = setup({ replyPolicy });
    vi.mocked(session.update).mockResolvedValueOnce({ id: 'old-attempt' }).mockRejectedValue(new Error('new attempt unknown'));
    vi.mocked(session.complete).mockRejectedValue(new Error('completion unknown'));
    outbound.routeStreamFrame('sess-qq', start('old')); outbound.routeStreamFrame('sess-qq', delta('old', 'old preamble'));
    await vi.advanceTimersByTimeAsync(200);
    outbound.routeStreamFrame('sess-qq', start('new')); outbound.routeStreamFrame('sess-qq', delta('new', 'new preamble'));
    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'new preamble' }] } } });
    await outbound.awaitText('sess-qq');
    expect(replyPolicy.hasReplyDelivered({} as SessionRecord)).toBe(false); expect(text.size).toBe(0); expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });
  it('acknowledges a receipted prefix without deduplicating its unconfirmed final tail', async () => {
    const { replyPolicy, text } = policy(), { outbound, bot, session } = setup({ replyPolicy });
    vi.mocked(session.update).mockResolvedValueOnce({ id: 'prefix' }).mockRejectedValue(new Error('tail unknown'));
    vi.mocked(session.complete).mockRejectedValue(new Error('completion unknown'));
    outbound.routeStreamFrame('sess-qq', start('one')); outbound.routeStreamFrame('sess-qq', delta('one', 'confirmed'));
    await vi.advanceTimersByTimeAsync(200); outbound.routeStreamFrame('sess-qq', delta('one', ' unknown tail'));
    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'confirmed unknown tail' }] } } });
    await outbound.awaitText('sess-qq');
    expect(replyPolicy.hasReplyDelivered({} as SessionRecord)).toBe(true); expect([...text]).toEqual(['confirmed']);
    expect(replyPolicy.hasDeliveredText({} as SessionRecord, 'confirmed unknown tail')).toBe(false); expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });
  it('suppresses identical explicit/final text while still delivering a different AI stage update', async () => {
    const { replyPolicy, text } = policy(); text.add('已经发送好了。');
    const { outbound, bot } = setup({ replyPolicy }); const session = { header: { id: 'sess-qq' } };
    const emit = (attempt: string, value: string) => {
      outbound.routeStreamFrame('sess-qq', start(attempt)); outbound.routeStreamFrame('sess-qq', delta(attempt, value));
      outbound.routeSessionEvent(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: value }] } } });
    };
    emit('duplicate', '已经发送好了。'); await outbound.awaitText('sess-qq'); expect(bot.sendMarkdown).not.toHaveBeenCalled(); expect(bot.openStream).not.toHaveBeenCalled();
    emit('progress', '资料已找到，现在开始整理页面。'); await outbound.awaitText('sess-qq');
    expect(bot.sendMarkdown).toHaveBeenCalledExactlyOnceWith(c2cTarget, '资料已找到，现在开始整理页面。');
    emit('repeated-progress', '资料已找到，现在开始整理页面。'); await outbound.awaitText('sess-qq'); expect(bot.sendMarkdown).toHaveBeenCalledTimes(1);
  });
  it('discards cancelled buffers, late messages, failures and presented files', async () => {
    const abort = new AbortController(), record = createRecord(c2cTarget); record.requestSignal = abort.signal;
    const deliverer = { deliver: vi.fn() }, { outbound, bot } = setup({ record, deliverer }); const session = { header: { id: 'sess-qq' } };
    outbound.routeStreamFrame('sess-qq', start('old')); outbound.routeStreamFrame('sess-qq', delta('old', '尚未发送的文字'));
    outbound.routeSessionEvent(session, { type: 'deliverables/presented', data: { turn: 1, callId: 'present', files: [{ path: '/old.pdf' }] } });
    abort.abort();
    outbound.routeSessionEvent(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '迟到的旧回复' }] } } });
    outbound.routeSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'error', code: 'CANCELLED', message: 'stop' } } });
    await outbound.awaitText('sess-qq'); expect(bot.sendMarkdown).not.toHaveBeenCalled(); expect(bot.openStream).not.toHaveBeenCalled(); expect(deliverer.deliver).not.toHaveBeenCalled();
  });
  it('interrupts a waiting pre-execute gate without waiting for an uncancellable SDK promise', async () => {
    const { outbound, bot } = setup({ config: createConfig({ streaming: false }) }); vi.mocked(bot.sendMarkdown).mockReturnValue(new Promise(() => {}));
    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '准备开始' }] } } });
    const controller = new AbortController(), waiting = outbound.awaitText('sess-qq', controller.signal); controller.abort(new Error('urgent stop'));
    await expect(waiting).rejects.toThrow('urgent stop'); outbound.cancel('sess-qq');
  });
  it.each([false, true])('leaves internal tool errors to AI unless diagnostics are enabled: %s', async showToolResults => {
    const { replyPolicy } = policy(), { outbound, bot } = setup({ config: createConfig({ showToolResults, streaming: false }), replyPolicy }); const session = { header: { id: 'sess-qq' } };
    outbound.routeSessionEvent(session, { type: 'tool/call', data: { callId: 'gate', name: 'zeta_speech_generate', arguments: '{}' } });
    outbound.routeSessionEvent(session, { type: 'tool/result', data: { message: { source: { callId: 'gate' } }, error: { name: 'ToolError', code: 'ACK_REQUIRED' } } });
    expect(bot.sendMarkdown).toHaveBeenCalledTimes(showToolResults ? 1 : 0);
    outbound.routeSessionEvent(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我会先准备合适的语气，再生成这段语音。' }] } } });
    await outbound.awaitText('sess-qq'); expect(bot.sendMarkdown).toHaveBeenLastCalledWith(c2cTarget, '我会先准备合适的语气，再生成这段语音。');
  });
});

describe('intentional group silence', () => {
  it('sends no automatic final text, placeholder, tool failure, turn failure or presented file', async () => {
    const deliverer = { deliver: vi.fn() };
    const { outbound, bot } = setup({ record: createRecord(groupTarget), deliverer, allowAutomatic: record => record.replyTarget.scope !== 'group' });
    const session = { header: { id: 'sess-qq' } };
    outbound.routeStreamFrame('sess-qq', start('a'));
    outbound.routeStreamFrame('sess-qq', delta('a', '（不回复）'));
    outbound.routeSessionEvent(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '（不回复）' }] } } });
    outbound.routeSessionEvent(session, { type: 'tool/call', data: { callId: 'call', name: 'bash', arguments: '{}' } });
    outbound.routeSessionEvent(session, { type: 'tool/result', data: { message: { source: { callId: 'call' } }, error: { name: 'Error', code: 'DENIED' } } });
    outbound.routeSessionEvent(session, { type: 'deliverables/presented', data: { turn: 1, callId: 'present', files: [{ path: '/report.txt' }] } });
    outbound.routeSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'FAILED', message: 'oops' } } } });
    await Promise.resolve(); expect(bot.sendMarkdown).not.toHaveBeenCalled(); expect(bot.openStream).not.toHaveBeenCalled(); expect(deliverer.deliver).not.toHaveBeenCalled();
  });
});

describe('OutboundRouter.routeStreamFrame', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('流式帧路由到会话 buffer：openStream + update', async () => {
    const { outbound, bot, session } = setup();

    outbound.routeStreamFrame('sess-qq', start('a1'));
    outbound.routeStreamFrame('sess-qq', delta('a1', 'hello'));
    await vi.advanceTimersByTimeAsync(200);

    expect(bot.openStream).toHaveBeenCalledTimes(1);
    expect(session.update).toHaveBeenCalledWith('hello');
  });

  it('attempt 切换 reset：同一条流式消息被新内容全量重写', async () => {
    const { outbound, bot, session } = setup();

    outbound.routeStreamFrame('sess-qq', start('a1'));
    outbound.routeStreamFrame('sess-qq', delta('a1', 'partial'));
    await vi.advanceTimersByTimeAsync(200);
    expect(session.update).toHaveBeenCalledWith('partial');

    outbound.routeStreamFrame('sess-qq', start('a2'));
    outbound.routeStreamFrame('sess-qq', delta('a2', 'full'));
    await vi.advanceTimersByTimeAsync(200);

    expect(bot.openStream).toHaveBeenCalledTimes(1); // 流式会话复用
    expect(session.update).toHaveBeenNthCalledWith(2, 'full'); // 全量替换
  });

  it('agent replacement（attemptId 重叠）：start 帧无条件重置', async () => {
    const { outbound, bot, session } = setup();

    outbound.routeStreamFrame('sess-qq', start('sess-qq:1'));
    outbound.routeStreamFrame('sess-qq', delta('sess-qq:1', 'stale'));
    await vi.advanceTimersByTimeAsync(200);
    expect(session.update).toHaveBeenCalledWith('stale');

    // agent replacement 后 attempt 计数重启，attemptId 与旧 agent 相同
    outbound.routeStreamFrame('sess-qq', start('sess-qq:1'));
    outbound.routeStreamFrame('sess-qq', delta('sess-qq:1', 'fresh'));
    await vi.advanceTimersByTimeAsync(200);

    expect(bot.openStream).toHaveBeenCalledTimes(1);
    expect(session.update).toHaveBeenNthCalledWith(2, 'fresh'); // 全量替换，无残留
  });

  it('迟到帧（旧 attemptId）被丢弃', async () => {
    const { outbound, session } = setup();

    outbound.routeStreamFrame('sess-qq', start('a1'));
    outbound.routeStreamFrame('sess-qq', delta('a1', 'x'));
    outbound.routeStreamFrame('sess-qq', start('a2'));
    outbound.routeStreamFrame('sess-qq', delta('a1', 'late')); // a1 的迟到帧
    await vi.advanceTimersByTimeAsync(200);

    expect(session.update).not.toHaveBeenCalledWith(expect.stringContaining('late'));
  });

  it('非 QQ 会话（无 record）忽略流式帧', async () => {
    const { outbound, bot } = setup({ record: undefined });

    outbound.routeStreamFrame('sess-web', start('a1'));
    outbound.routeStreamFrame('sess-web', delta('a1', 'hello'));
    await vi.advanceTimersByTimeAsync(200);

    expect(bot.openStream).not.toHaveBeenCalled();
    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });

  it('群聊不流式：帧累积后由 assistant/message 静态发送', async () => {
    const { outbound, bot } = setup({ record: createRecord(groupTarget) });

    outbound.routeStreamFrame('sess-qq', start('a1'));
    outbound.routeStreamFrame('sess-qq', delta('a1', 'group reply'));
    await vi.advanceTimersByTimeAsync(200);

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'group reply' }] } },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(bot.openStream).not.toHaveBeenCalled();
    expect(bot.sendMarkdown).toHaveBeenCalledWith(groupTarget, 'group reply');
  });

  it('assistant/message 到达时收尾流式：complete 且不重复静态发送', async () => {
    const { outbound, bot, session } = setup();

    outbound.routeStreamFrame('sess-qq', start('a1'));
    outbound.routeStreamFrame('sess-qq', delta('a1', 'hello'));
    await vi.advanceTimersByTimeAsync(200);

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'hello' }] } },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(session.complete).toHaveBeenCalledTimes(1);
    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });

  it('旧通道回归：durable assistant/chunk 事件仍进 buffer', async () => {
    const { outbound, bot, session } = setup();

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'assistant/chunk',
      data: { chunk: { type: 'text-delta', text: 'legacy' } },
    });
    await vi.advanceTimersByTimeAsync(200);

    expect(bot.openStream).toHaveBeenCalledTimes(1);
    expect(session.update).toHaveBeenCalledWith('legacy');
  });
});

describe('OutboundRouter: deliverables/presented', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const presentedEvent = (callId: string, files: Array<{ path: string; description?: string }>) => ({
    type: 'deliverables/presented',
    data: { turn: 1, callId, files },
  });
  const turnEnd = { type: 'turn/end', data: { reason: { kind: 'stop' } } };
  const record = createRecord(c2cTarget);

  it('轮末投递声明的文件，且在文本之后', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const { outbound, bot } = setup({ deliverer: { deliver } });

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, presentedEvent('c1', [{ path: '/tmp/report.xlsx' }]));
    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'final reply' }] } },
    });
    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, turnEnd);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(record, [{ path: '/tmp/report.xlsx' }]);
    // 文本先于文件：markdown 发送的调用序在 deliver 之前
    const textOrder = (bot.sendMarkdown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(textOrder).toBeLessThan(deliver.mock.invocationCallOrder[0]);
  });

  it('同 callId 去重：事件重放不重复投递', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const { outbound } = setup({ deliverer: { deliver } });

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, presentedEvent('c1', [{ path: '/tmp/a.png' }]));
    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, presentedEvent('c1', [{ path: '/tmp/a.png' }]));
    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, presentedEvent('c2', [{ path: '/tmp/b.png' }]));
    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, turnEnd);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(record, [{ path: '/tmp/a.png' }, { path: '/tmp/b.png' }]);
  });

  it('assistant/message 在途文本未送达前不投递文件（等待 pending 发送完成）', async () => {
    let resolveText: (() => void) | undefined;
    const textTask = new Promise<void>((resolve) => { resolveText = resolve; });
    const bot: QQBotSender = {
      sendMarkdown: vi.fn(() => textTask),
      openStream: vi.fn(() => createSession()),
    };
    const record = createRecord(c2cTarget);
    const manager = {
      findBySessionId: vi.fn(() => record),
    } as unknown as SessionManager;
    const deliver = vi.fn().mockResolvedValue(undefined);
    const outbound = createOutboundHandler(manager, bot, createConfig(), createLogger(), undefined, { deliver });

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, presentedEvent('c1', [{ path: '/tmp/a.png' }]));
    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'reply' }] } },
    });
    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, turnEnd);
    await Promise.resolve();
    await Promise.resolve();
    expect(deliver).not.toHaveBeenCalled(); // 文本仍在途

    resolveText?.();
    for (let i = 0; i < 10; i++) await Promise.resolve(); // 冲刷 catch 派生 + Promise.all 的微任务链
    expect(deliver).toHaveBeenCalledTimes(1); // 文本送达后才投递
  });

  it('配置关闭时不投递', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const { outbound } = setup({
      config: createConfig({ sendFile: { restrictPaths: true, extraRoots: [], sendPresentedFiles: false, maxFiles: 4 } as ImQQBotConfig['sendFile'] }),
      deliverer: { deliver },
    });

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, presentedEvent('c1', [{ path: '/tmp/a.png' }]));
    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, turnEnd);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(deliver).not.toHaveBeenCalled();
  });

  it('异常结束的轮次仍投递已声明的文件（宿主契约：失败不撤销声明）', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const { outbound, bot } = setup({ deliverer: { deliver } });

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, presentedEvent('c1', [{ path: '/tmp/a.png' }]));
    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'E_BROKEN', message: 'boom' } } },
    });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(bot.sendMarkdown).toHaveBeenCalledWith(c2cTarget, expect.stringContaining('E_BROKEN'));
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('未提供投递器时静默跳过（老环境降级）', async () => {
    const { outbound, bot } = setup();

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, presentedEvent('c1', [{ path: '/tmp/a.png' }]));
    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, turnEnd);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });
});
