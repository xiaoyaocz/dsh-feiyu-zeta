import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamSession } from '@tencent-connect/qqbot-nodejs';
import { OutboundBuffer } from './outbound-buffer.ts';
import type { QQBotSender, StreamSessionLike } from './outbound-buffer.ts';
import type { SessionRecord } from '../session/index.ts';
import type { Logger, ReplyTarget } from '../types.ts';

function createLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createSession(): StreamSessionLike {
  return { update: vi.fn().mockResolvedValue(undefined), complete: vi.fn().mockResolvedValue({ id: 'stream1' }), cancel: vi.fn() };
}

function createBot(openStreamImpl?: () => StreamSessionLike): QQBotSender {
  return {
    sendMarkdown: vi.fn().mockResolvedValue(undefined),
    openStream: vi.fn(openStreamImpl ?? (() => createSession())),
  };
}

function createRecord(target: ReplyTarget): SessionRecord {
  return {
    sessionId: 's1',
    key: 'k',
    replyTarget: target,
    agent: {},
    createdAt: 0,
    lastActiveAt: 0,
  } as unknown as SessionRecord;
}

const c2cTarget: ReplyTarget = { scope: 'c2c', targetId: 'user1', msgId: 'msg1' };

describe('OutboundBuffer', () => {
  it('drops unsent text and stream timers when its request is cancelled', async () => {
    const controller = new AbortController(), delivered = vi.fn(), bot = createBot();
    const buffer = new OutboundBuffer(createRecord(c2cTarget), bot, 4500, createLogger(), true, { signal: controller.signal, onDelivered: delivered });
    buffer.append('AI写的开场'); controller.abort(); await vi.advanceTimersByTimeAsync(1000); await buffer.flush();
    expect(bot.openStream).not.toHaveBeenCalled(); expect(bot.sendMarkdown).not.toHaveBeenCalled(); expect(delivered).not.toHaveBeenCalled();
  });
  it('does not continue static chunks after stop or credit a late receipt to another request', async () => {
    const controller = new AbortController(), delivered = vi.fn(), bot = createBot(); let resolveSend!: () => void;
    vi.mocked(bot.sendMarkdown).mockImplementationOnce(() => new Promise<void>(resolve => { resolveSend = resolve; }));
    const record = createRecord({ ...c2cTarget }), buffer = new OutboundBuffer(record, bot, 5, createLogger(), false, { signal: controller.signal, onDelivered: delivered });
    buffer.append('hello world'); const sending = buffer.flush(); record.replyTarget = { scope: 'group', targetId: 'other-group', msgId: 'new-message' };
    controller.abort(); resolveSend(); await sending;
    expect(bot.sendMarkdown).toHaveBeenCalledTimes(1); expect(bot.sendMarkdown).toHaveBeenCalledWith(c2cTarget, expect.any(String)); expect(delivered).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('流式开启：append + flush → openStream + update + complete', async () => {
    const session = createSession();
    const bot = createBot(() => session);
    const buffer = new OutboundBuffer(createRecord(c2cTarget), bot, 4500, createLogger(), true);

    buffer.append('hello');
    await buffer.flush();

    expect(bot.openStream).toHaveBeenCalledTimes(1);
    expect(session.update).toHaveBeenCalledWith('hello');
    expect(session.complete).toHaveBeenCalledTimes(1);
    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });

  it('流式关闭：append + flush → 静态 sendMarkdown', async () => {
    const bot = createBot();
    const buffer = new OutboundBuffer(createRecord(c2cTarget), bot, 4500, createLogger(), false);

    buffer.append('hello');
    await buffer.flush();

    expect(bot.openStream).not.toHaveBeenCalled();
    expect(bot.sendMarkdown).toHaveBeenCalledWith(c2cTarget, 'hello');
  });

  it('流式开启但 openStream 失败 → 降级静态 sendMarkdown', async () => {
    const bot = createBot(() => {
      throw new Error('open failed');
    });
    const buffer = new OutboundBuffer(createRecord(c2cTarget), bot, 4500, createLogger(), true);

    buffer.append('hello');
    await vi.advanceTimersByTimeAsync(200);
    await buffer.flush();

    // 流式从未成功发送 → 降级静态
    expect(bot.sendMarkdown).toHaveBeenCalledWith(c2cTarget, 'hello');
  });

  it('cancel → abort 取消会话且不发送 DONE', async () => {
    const session = createSession();
    const bot = createBot(() => session);
    const buffer = new OutboundBuffer(createRecord(c2cTarget), bot, 4500, createLogger(), true);

    buffer.append('hello');
    await vi.advanceTimersByTimeAsync(200);
    buffer.cancel();
    await vi.runAllTimersAsync();

    expect(session.cancel).toHaveBeenCalledTimes(1);
    expect(session.complete).not.toHaveBeenCalled();
  });

  it('reset 清空累积文本并保留流式会话', async () => {
    const session = createSession();
    const bot = createBot(() => session);
    const buffer = new OutboundBuffer(createRecord(c2cTarget), bot, 4500, createLogger(), true);

    buffer.append('old');
    await vi.advanceTimersByTimeAsync(200);
    expect(session.update).toHaveBeenCalledWith('old');

    buffer.reset();
    expect(buffer.text).toBe('');

    buffer.append('new');
    await buffer.flush();

    expect(bot.openStream).toHaveBeenCalledTimes(1); // 会话复用
    expect(session.update).toHaveBeenNthCalledWith(2, 'new'); // 全量替换
    expect(session.complete).toHaveBeenCalledTimes(1);
    expect(bot.sendMarkdown).not.toHaveBeenCalled(); // 不降级静态
  });

  it('does not report a failed retry as delivered just because the old attempt had a receipt', async () => {
    const session: StreamSessionLike = {
      update: vi.fn().mockResolvedValueOnce({ id: 'old' }).mockRejectedValue(new Error('new update unknown')),
      complete: vi.fn().mockRejectedValue(new Error('completion unknown')),
    };
    const bot = createBot(() => session), delivered = vi.fn();
    const buffer = new OutboundBuffer(createRecord(c2cTarget), bot, 4500, createLogger(), true, { onDelivered: delivered });
    buffer.append('old preamble'); await vi.advanceTimersByTimeAsync(200);
    buffer.reset(); buffer.append('new preamble'); await buffer.flush();
    expect(delivered).not.toHaveBeenCalled(); expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });

  it('reports only the confirmed prefix when the final text has no receipt', async () => {
    const session: StreamSessionLike = {
      update: vi.fn().mockResolvedValueOnce({ id: 'prefix' }).mockRejectedValue(new Error('tail unknown')),
      complete: vi.fn().mockRejectedValue(new Error('completion unknown')),
    };
    const bot = createBot(() => session), delivered = vi.fn();
    const buffer = new OutboundBuffer(createRecord(c2cTarget), bot, 4500, createLogger(), true, { onDelivered: delivered });
    buffer.append('confirmed'); await vi.advanceTimersByTimeAsync(200);
    buffer.append(' unknown tail'); await buffer.flush();
    expect(delivered).toHaveBeenCalledExactlyOnceWith('confirmed'); expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });

  it('does not credit merely queued SDK text or resend a stream with unknown completion', async () => {
    const session = createSession(); vi.mocked(session.complete).mockRejectedValue(new Error('completion unknown'));
    const bot = createBot(() => session), delivered = vi.fn();
    const buffer = new OutboundBuffer(createRecord(c2cTarget), bot, 4500, createLogger(), true, { onDelivered: delivered });
    buffer.append('queued only'); await buffer.flush();
    expect(delivered).not.toHaveBeenCalled(); expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });

  it('uses the installed SDK receipt semantics when its final DONE request fails', async () => {
    const send = vi.fn().mockResolvedValueOnce({ id: 'generating-frame', timestamp: 1 }).mockRejectedValue(new Error('DONE response unknown'));
    const session = new StreamSession({ sendC2CStreamMessage: send } as unknown as ConstructorParameters<typeof StreamSession>[0], {
      openid: 'fixture-user', msgId: 'fixture-message', creds: { appId: 'offline-fixture', clientSecret: 'not-a-real-secret' },
    });
    const bot = createBot(() => session), delivered = vi.fn();
    const buffer = new OutboundBuffer(createRecord(c2cTarget), bot, 4500, createLogger(), true, { onDelivered: delivered });
    buffer.append('prefix'); await vi.advanceTimersByTimeAsync(200);
    // SDK update fulfilled, but does not expose even the successful GENERATING
    // receipt. A following throttled update resolves before sending at all.
    expect(send).toHaveBeenCalledTimes(1); buffer.append(' queued tail'); await buffer.flush();
    expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[1]?.[2]).toMatchObject({ content_raw: 'prefix queued tail', input_state: 10 });
    expect(delivered).not.toHaveBeenCalled(); expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });

  it('cancels installed SDK pending frames without publishing a new DONE message after stop', async () => {
    const send = vi.fn().mockResolvedValue({ id: 'generating-frame', timestamp: 1 });
    const session = new StreamSession({ sendC2CStreamMessage: send } as unknown as ConstructorParameters<typeof StreamSession>[0], {
      openid: 'fixture-user', msgId: 'fixture-stop-message', creds: { appId: 'offline-fixture', clientSecret: 'not-a-real-secret' },
    });
    const bot = createBot(() => session), delivered = vi.fn();
    const buffer = new OutboundBuffer(createRecord(c2cTarget), bot, 4500, createLogger(), true, { onDelivered: delivered });
    buffer.append('prefix'); await vi.advanceTimersByTimeAsync(200);
    buffer.append(' pending tail'); await vi.advanceTimersByTimeAsync(200);
    expect(send).toHaveBeenCalledTimes(1); buffer.cancel(); await vi.runAllTimersAsync(); await buffer.flush();
    expect(send).toHaveBeenCalledTimes(1); expect(delivered).not.toHaveBeenCalled(); expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });

  it('credits SDK final text only after the final frame returns its receipt', async () => {
    const session = createSession(); let receipt!: (value: unknown) => void;
    vi.mocked(session.complete).mockImplementationOnce(() => new Promise(resolve => { receipt = resolve; }));
    const bot = createBot(() => session), delivered = vi.fn();
    const buffer = new OutboundBuffer(createRecord(c2cTarget), bot, 4500, createLogger(), true, { onDelivered: delivered });
    buffer.append('AI preamble'); const flushing = buffer.flush();
    await vi.advanceTimersByTimeAsync(0); expect(delivered).not.toHaveBeenCalled();
    receipt({ id: 'real-done-frame' }); await flushing;
    expect(delivered).toHaveBeenCalledExactlyOnceWith('AI preamble'); expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });
});
