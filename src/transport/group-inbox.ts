/** Per-group trailing debounce, bounded from the first message, with serial batches. */
interface Item<T> { value: T; done(): void }
interface Inbox<T> { items: Item<T>[]; firstAt: number; lastAt: number; running: boolean; timer?: ReturnType<typeof setTimeout>; active?: AbortController }
export class GroupInbox<T> {
  private readonly groups = new Map<string, Inbox<T>>();
  private disposed = false;
  constructor(private readonly timing: () => { waitMs: number; maxWaitMs: number }, private readonly process: (values: T[], signal: AbortSignal) => Promise<void>, private readonly onError: (error: unknown) => void = () => {}, private readonly maxPending = 100) {}
  enqueue(key: string, value: T): Promise<void> {
    if (this.disposed) return Promise.resolve();
    let group = this.groups.get(key);
    if (!group) { group = { items: [], firstAt: Date.now(), lastAt: Date.now(), running: false }; this.groups.set(key, group); }
    if (group.items.length >= Math.max(1, this.maxPending)) { this.onError(new Error('消息待处理队列已满，本条未进入AI回合')); return Promise.resolve(); }
    if (!group.items.length) group.firstAt = Date.now();
    group.lastAt = Date.now();
    const done = new Promise<void>(resolve => { group!.items.push({ value, done: resolve }); });
    if (!group.running) this.schedule(key, group);
    return done;
  }
  private schedule(key: string, group: Inbox<T>): void {
    if (group.timer) clearTimeout(group.timer);
    const { waitMs, maxWaitMs } = this.timing();
    const due = Math.min(group.lastAt + Math.max(0, waitMs), group.firstAt + Math.max(waitMs, maxWaitMs));
    group.timer = setTimeout(() => { group.timer = undefined; void this.flush(key, group); }, Math.max(0, due - Date.now()));
  }
  private async flush(key: string, group: Inbox<T>): Promise<void> {
    if (this.disposed || group.running || !group.items.length) return;
    group.running = true;
    group.active = new AbortController();
    const items = group.items.splice(0);
    try { await this.process(items.map(item => item.value), group.active.signal); }
    catch (error) { this.onError(error); }
    finally {
      for (const item of items) item.done();
      group.running = false;
      group.active = undefined;
      if (this.groups.get(key) === group) {
        if (group.items.length) this.schedule(key, group);
        else this.groups.delete(key);
      }
    }
  }
  cancel(key: string): void {
    const group = this.groups.get(key);
    if (!group) return;
    group.active?.abort();
    if (group.timer) clearTimeout(group.timer);
    for (const item of group.items.splice(0)) item.done();
    if (!group.running) this.groups.delete(key);
  }
  dispose(): void { this.disposed = true; for (const key of this.groups.keys()) this.cancel(key); }
}
