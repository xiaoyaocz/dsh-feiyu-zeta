import { afterEach, describe, expect, it, vi } from 'vitest';
import { GroupInbox } from './group-inbox.ts';
import { splitRequestBatches } from '../zeta/permissions.ts';

afterEach(() => vi.useRealTimers());
describe('per-group bounded message batching', () => {
  it('waits for the first message and preserves all full message objects and attachments', async () => {
    vi.useFakeTimers(); const process = vi.fn(async () => {});
    const inbox = new GroupInbox(() => ({ waitMs: 2000, maxWaitMs: 6000 }), process);
    const first = { senderId: 'alice', text: '你好', messageId: '1' };
    const second = { senderId: 'bob', text: '', messageId: '2', attachments: ['image.gif'] };
    const p1 = inbox.enqueue('g', first);
    await vi.advanceTimersByTimeAsync(1500); expect(process).not.toHaveBeenCalled();
    const p2 = inbox.enqueue('g', second);
    await vi.advanceTimersByTimeAsync(1999); expect(process).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await Promise.all([p1, p2]);
    expect(process).toHaveBeenCalledExactlyOnceWith([first, second], expect.any(AbortSignal)); inbox.dispose();
  });
  it('caps the delay despite continued traffic, and groups have independent timers', async () => {
    vi.useFakeTimers(); const process = vi.fn(async () => {});
    const inbox = new GroupInbox<number>(() => ({ waitMs: 2000, maxWaitMs: 6000 }), process);
    const pending = [inbox.enqueue('a', 1), inbox.enqueue('b', 100)];
    for (let i = 2; i <= 6; i++) { await vi.advanceTimersByTimeAsync(1000); pending.push(inbox.enqueue('a', i)); }
    expect(process).toHaveBeenCalledWith([100], expect.any(AbortSignal));
    await vi.advanceTimersByTimeAsync(1000); await Promise.all(pending);
    expect(process).toHaveBeenCalledWith([1, 2, 3, 4, 5, 6], expect.any(AbortSignal)); inbox.dispose();
  });
  it('never overlaps batches for a group and cancels queued timers during stop/unload', async () => {
    vi.useFakeTimers(); let release!: () => void;
    const process = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const inbox = new GroupInbox<number>(() => ({ waitMs: 2000, maxWaitMs: 6000 }), process);
    const p1 = inbox.enqueue('g', 1); await vi.advanceTimersByTimeAsync(2000);
    const p2 = inbox.enqueue('g', 2); await vi.advanceTimersByTimeAsync(10000); expect(process).toHaveBeenCalledTimes(1);
    inbox.cancel('g'); await p2; release(); await p1;
    const p3 = inbox.enqueue('g', 3); inbox.dispose(); await p3;
    await vi.advanceTimersByTimeAsync(10000); expect(process).toHaveBeenCalledTimes(1);
  });
  it('a new message after cancelling queued work still waits for the active batch to settle', async () => {
    vi.useFakeTimers(); let release!: () => void;
    const process = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; })).mockResolvedValue(undefined);
    const inbox = new GroupInbox<number>(() => ({ waitMs: 2000, maxWaitMs: 6000 }), process);
    const p1 = inbox.enqueue('g', 1); await vi.advanceTimersByTimeAsync(2000);
    inbox.cancel('g'); const p2 = inbox.enqueue('g', 2); await vi.advanceTimersByTimeAsync(10000);
    expect(process).toHaveBeenCalledTimes(1); release(); await p1; await vi.advanceTimersByTimeAsync(0); await p2;
    expect(process).toHaveBeenNthCalledWith(2, [2], expect.any(AbortSignal)); inbox.dispose();
  });
  it('cancels remaining administrator requests from an already-dequeued group batch on stop or new', async () => {
    vi.useFakeTimers(); let release!: () => void; let activeSignal!: AbortSignal;
    const held = new Promise<void>(resolve => { release = resolve; });
    const processed: string[][] = [];
    const inbox = new GroupInbox<string>(() => ({ waitMs: 10, maxWaitMs: 10 }), async (messages, signal) => {
      activeSignal = signal;
      for (const request of splitRequestBatches(messages, sender => sender, sender => sender === 'owner')) {
        if (signal.aborted) break;
        processed.push(request);
        if (request[0] === 'member') await held;
      }
    });
    const first = inbox.enqueue('g', 'member'), sensitive = inbox.enqueue('g', 'owner');
    await vi.advanceTimersByTimeAsync(10); expect(processed).toEqual([['member']]);
    inbox.cancel('g'); expect(activeSignal.aborted).toBe(true);
    const fresh = inbox.enqueue('g', 'new-member');
    await vi.advanceTimersByTimeAsync(100); expect(processed).toEqual([['member']]);
    release(); await Promise.all([first, sensitive]); await vi.advanceTimersByTimeAsync(0); await fresh;
    expect(processed).toEqual([['member'], ['new-member']]);
    expect(activeSignal.aborted).toBe(false); inbox.dispose();
  });
});
