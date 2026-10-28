import { describe, expect, it, vi } from 'vitest';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { isNaturalStop, naturalStop } from './stop.ts';
import { GroupInbox } from '../transport/group-inbox.ts';
import { SessionManager } from '../session/session-manager.ts';

describe('urgent natural stop', () => {
  it.each(['停停停', '停一下！', '停止生成', '取消当前任务', '停停停，不要再发了', '<@!123> 停停停', 'stop'])('recognizes the whole stop intent: %s', text => {
    expect(isNaturalStop(text, '123')).toBe(true);
  });
  it.each(['别停', '不要停止', '继续生成', '他说“停停停”是什么意思', '请解释 stop 命令', '停止后再生成一张', '停下来喝杯茶的故事', '停停停<@!456>'])('does not interrupt for quoted, negated or mixed work: %s', text => {
    expect(isNaturalStop(text, '123')).toBe(false);
  });
  it.each(['c2c', 'group'] as const)('cancels active and queued %s work immediately without queuing a reply', async scope => {
    vi.useFakeTimers();
    try {
      let running!: AbortSignal;
      const process = vi.fn(async (_values: string[], signal: AbortSignal) => {
        running = signal;
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      });
      const inbox = new GroupInbox<string>(() => ({ waitMs: 0, maxWaitMs: 0 }), process);
      const first = inbox.enqueue('peer', 'long work'); await vi.advanceTimersByTimeAsync(0);
      const queued = inbox.enqueue('peer', 'must not start');
      const abort = new AbortController(), cancel = vi.fn();
      const record = { sessionKey: 'trusted-key', abortRequest: () => abort.abort(), agent: { cancel } };
      const manager = { getSessionRecord: vi.fn(() => record), interrupt: SessionManager.prototype.interrupt,
        questionChannel: { cancelPending: vi.fn() }, approvalChannel: { cancelPending: vi.fn() } } as unknown as SessionManager;
      const next = vi.fn(), stop = vi.fn(), send = vi.fn();
      const context = { message: { kind: scope, senderId: scope === 'c2c' ? 'peer' : 'member', groupOpenid: scope === 'group' ? 'peer' : undefined, content: '停停停' }, bot: { appId: '123', sendMarkdown: send }, stop } as unknown as MiddlewareContext;
      await naturalStop(manager, (_scope, peerId) => inbox.cancel(peerId))(context, next);
      expect(running.aborted).toBe(true); expect(abort.signal.aborted).toBe(true); expect(cancel).toHaveBeenCalledWith({ kind: 'user' });
      expect(manager.questionChannel!.cancelPending).toHaveBeenCalledWith('trusted-key'); expect(manager.approvalChannel!.cancelPending).toHaveBeenCalledWith('trusted-key');
      expect(stop).toHaveBeenCalledWith('natural-stop'); expect(next).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
      await Promise.all([first, queued]); await vi.advanceTimersByTimeAsync(10000); expect(process).toHaveBeenCalledTimes(1); inbox.dispose();
    } finally { vi.useRealTimers(); }
  });
});
