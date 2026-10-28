import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamingWriter } from './streaming-writer.ts';
import type { QQBotSender, StreamSessionLike } from './outbound-buffer.ts';
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

const target: ReplyTarget = { scope: 'c2c', targetId: 'user1', msgId: 'msg1' };

describe('StreamingWriter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('首次 append 后节流触发 openStream + update', async () => {
    const session = createSession();
    const bot = createBot(() => session);
    const writer = new StreamingWriter({ bot, target, logger: createLogger(), throttleMs: 200 });

    writer.append('hello');
    await vi.advanceTimersByTimeAsync(200);

    expect(bot.openStream).toHaveBeenCalledTimes(1);
    expect(session.update).toHaveBeenCalledWith('hello');
  });

  it('同 tick 内多次 append 只触发一次 update', async () => {
    const session = createSession();
    const bot = createBot(() => session);
    const writer = new StreamingWriter({ bot, target, logger: createLogger(), throttleMs: 200 });

    writer.append('Hello');
    writer.append(' ');
    writer.append('world');
    await vi.advanceTimersByTimeAsync(200);

    // throttle：同一 tick 内多次 append 共用一个 timer，只触发一次 update
    expect(session.update).toHaveBeenCalledTimes(1);
    expect(session.update).toHaveBeenCalledWith('Hello world');
  });

  it('throttle：跨节流间隔的 append 分多次 update', async () => {
    const session = createSession();
    const bot = createBot(() => session);
    const writer = new StreamingWriter({ bot, target, logger: createLogger(), throttleMs: 200 });

    writer.append('a');
    await vi.advanceTimersByTimeAsync(200); // 第一次 flush → update('a')

    writer.append('b');
    await vi.advanceTimersByTimeAsync(200); // 第二次 flush → update('ab')

    expect(session.update).toHaveBeenCalledTimes(2);
    expect(session.update).toHaveBeenNthCalledWith(1, 'a');
    expect(session.update).toHaveBeenNthCalledWith(2, 'ab');
  });

  it('finish 触发最终 update + complete', async () => {
    const session = createSession();
    const bot = createBot(() => session);
    const writer = new StreamingWriter({ bot, target, logger: createLogger(), throttleMs: 200 });

    writer.append('hello');
    await writer.finish();

    expect(session.update).toHaveBeenCalledWith('hello');
    expect(session.complete).toHaveBeenCalledTimes(1);
  });

  it('openStream 同步失败 → shouldFallback = true（尚未尝试发送）', async () => {
    const bot = createBot(() => {
      throw new Error('open failed');
    });
    const writer = new StreamingWriter({ bot, target, logger: createLogger(), throttleMs: 200 });

    writer.append('hello');
    await vi.advanceTimersByTimeAsync(200);

    expect(writer.shouldFallback).toBe(true);
    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });

  it('首次 update 结果未知不能静态补发或确认收到', async () => {
    const session: StreamSessionLike = {
      update: vi.fn().mockRejectedValueOnce(new Error('update failed')),
      complete: vi.fn().mockResolvedValue(undefined),
    };
    const bot = createBot(() => session);
    const writer = new StreamingWriter({ bot, target, logger: createLogger(), throttleMs: 200 });

    writer.append('hello');
    await vi.advanceTimersByTimeAsync(200);

    await writer.finish();
    expect(writer.shouldFallback).toBe(false);
    expect(writer.confirmedText).toBeUndefined();
    expect(writer.finalTextConfirmed).toBe(false);
    expect(session.update).toHaveBeenCalledTimes(1);
  });

  it('后续 update 失败 → shouldFallback = false（已发送过分片，不降级避免重复）', async () => {
    const session: StreamSessionLike = {
      update: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('later update failed')),
      complete: vi.fn().mockResolvedValue(undefined),
    };
    const bot = createBot(() => session);
    const writer = new StreamingWriter({ bot, target, logger: createLogger(), throttleMs: 200 });

    writer.append('a');
    await vi.advanceTimersByTimeAsync(200);
    expect(writer.shouldFallback).toBe(false); // 已尝试发送，未知结果也不能静态重发

    writer.append('b');
    await vi.advanceTimersByTimeAsync(200);
    // 第二次 update 失败，不降级
    expect(writer.shouldFallback).toBe(false);
  });

  it('finish 幂等：重复 finish 只 complete 一次', async () => {
    const session = createSession();
    const bot = createBot(() => session);
    const writer = new StreamingWriter({ bot, target, logger: createLogger(), throttleMs: 200 });

    writer.append('hello');
    await writer.finish();
    await writer.finish();

    expect(session.complete).toHaveBeenCalledTimes(1);
  });

  it('finish 后 append 被忽略', async () => {
    const session = createSession();
    const bot = createBot(() => session);
    const writer = new StreamingWriter({ bot, target, logger: createLogger(), throttleMs: 200 });

    writer.append('hello');
    await writer.finish();

    writer.append('world');
    expect(writer.text).toBe('hello'); // 终态后 append 不再累积
  });

  it('abort 取消已打开会话，不用 complete 发送待发尾部', async () => {
    const session = createSession();
    const bot = createBot(() => session);
    const writer = new StreamingWriter({ bot, target, logger: createLogger(), throttleMs: 200 });

    writer.append('hello');
    await vi.advanceTimersByTimeAsync(200);
    expect(bot.openStream).toHaveBeenCalledTimes(1);

    writer.abort();
    await vi.runAllTimersAsync();

    expect(session.cancel).toHaveBeenCalledTimes(1);
    expect(session.complete).not.toHaveBeenCalled();
  });

  it('an adapter without cancel is never completed as a stop fallback', async () => {
    const session: StreamSessionLike = { update: vi.fn().mockResolvedValue(undefined), complete: vi.fn().mockResolvedValue({ id: 'must-not-send' }) };
    const writer = new StreamingWriter({ bot: createBot(() => session), target, logger: createLogger(), throttleMs: 200 });
    writer.append('prefix'); await vi.advanceTimersByTimeAsync(200);
    writer.append(' pending tail'); writer.abort(); await vi.runAllTimersAsync(); await writer.finish();
    expect(session.update).toHaveBeenCalledExactlyOnceWith('prefix'); expect(session.complete).not.toHaveBeenCalled(); expect(writer.confirmedText).toBeUndefined();
  });

  it('reset 清空累积文本，复用已打开会话，新内容全量重写', async () => {
    const session = createSession();
    const bot = createBot(() => session);
    const writer = new StreamingWriter({ bot, target, logger: createLogger(), throttleMs: 200 });

    writer.append('attempt-a');
    await vi.advanceTimersByTimeAsync(200);
    expect(session.update).toHaveBeenCalledWith('attempt-a');

    writer.reset();
    writer.append('attempt-b');
    await vi.advanceTimersByTimeAsync(200);

    expect(writer.text).toBe('attempt-b');
    expect(bot.openStream).toHaveBeenCalledTimes(1); // 流式会话复用，不新开消息
    expect(session.update).toHaveBeenNthCalledWith(2, 'attempt-b'); // 全量替换
    expect(writer.shouldFallback).toBe(false); // 保留网络尝试标记，不降级
  });

  it('old attempt receipt cannot acknowledge a failed new attempt', async () => {
    const session: StreamSessionLike = {
      update: vi.fn().mockResolvedValueOnce({ id: 'old-receipt' }).mockRejectedValue(new Error('new update unknown')),
      complete: vi.fn().mockRejectedValue(new Error('completion unknown')),
    };
    const writer = new StreamingWriter({ bot: createBot(() => session), target, logger: createLogger(), throttleMs: 200 });
    writer.append('old preamble'); await vi.advanceTimersByTimeAsync(200);
    expect(writer.confirmedText).toBe('old preamble');
    writer.reset(); writer.append('new preamble'); await writer.finish();
    expect(writer.confirmedText).toBeUndefined(); expect(writer.finalTextConfirmed).toBe(false); expect(writer.shouldFallback).toBe(false);
  });

  it('confirmed prefix does not acknowledge the unconfirmed final tail', async () => {
    const session: StreamSessionLike = {
      update: vi.fn().mockResolvedValueOnce({ id: 'prefix-receipt' }).mockRejectedValue(new Error('tail unknown')),
      complete: vi.fn().mockRejectedValue(new Error('completion unknown')),
    };
    const writer = new StreamingWriter({ bot: createBot(() => session), target, logger: createLogger(), throttleMs: 200 });
    writer.append('confirmed'); await vi.advanceTimersByTimeAsync(200);
    writer.append(' unknown tail'); await writer.finish();
    expect(writer.confirmedText).toBe('confirmed'); expect(writer.finalTextConfirmed).toBe(false); expect(writer.shouldFallback).toBe(false);
  });

  it('a late old-attempt update receipt never confirms current text', async () => {
    let resolveOld!: (value: unknown) => void;
    const session: StreamSessionLike = {
      update: vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockRejectedValue(new Error('new update unknown')),
      complete: vi.fn().mockRejectedValue(new Error('completion unknown')),
    };
    const writer = new StreamingWriter({ bot: createBot(() => session), target, logger: createLogger(), throttleMs: 200 });
    writer.append('old'); await vi.advanceTimersByTimeAsync(200);
    writer.reset(); writer.append('new'); const finishing = writer.finish();
    resolveOld({ id: 'late-old' }); await finishing;
    expect(writer.confirmedText).toBeUndefined(); expect(writer.finalTextConfirmed).toBe(false);
  });

  it('SDK-style queued updates are confirmed only by a real final receipt', async () => {
    const session = createSession(), writer = new StreamingWriter({ bot: createBot(() => session), target, logger: createLogger(), throttleMs: 200 });
    writer.append('queued'); await vi.advanceTimersByTimeAsync(200);
    expect(writer.confirmedText).toBeUndefined(); expect(writer.finalTextConfirmed).toBe(false);
    await writer.finish(); expect(writer.confirmedText).toBe('queued'); expect(writer.finalTextConfirmed).toBe(true);
  });

  it.each([undefined, null, {}, { id: '' }, { id: ' ' }])('completion without a usable receipt id stays unknown: %j', async receipt => {
    const session = createSession(); vi.mocked(session.complete).mockResolvedValue(receipt);
    const writer = new StreamingWriter({ bot: createBot(() => session), target, logger: createLogger(), throttleMs: 200 });
    writer.append('possibly queued'); await writer.finish();
    expect(writer.confirmedText).toBeUndefined(); expect(writer.finalTextConfirmed).toBe(false); expect(writer.shouldFallback).toBe(false);
  });

  it('a completion receipt never credits a submission whose update failed', async () => {
    const session = createSession(); vi.mocked(session.update).mockRejectedValue(new Error('update failed before queue acceptance'));
    const writer = new StreamingWriter({ bot: createBot(() => session), target, logger: createLogger(), throttleMs: 200 });
    writer.append('not confirmed'); await writer.finish();
    expect(writer.confirmedText).toBeUndefined(); expect(writer.finalTextConfirmed).toBe(false);
  });

  it('finish 后 reset 不复活 writer', async () => {
    const session = createSession();
    const bot = createBot(() => session);
    const writer = new StreamingWriter({ bot, target, logger: createLogger(), throttleMs: 200 });

    writer.append('hello');
    await writer.finish();
    writer.reset();

    expect(writer.text).toBe('hello'); // 终态后 reset 无效
  });
});
