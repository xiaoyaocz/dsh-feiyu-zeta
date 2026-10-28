export class GroupInbox {
    timing;
    process;
    onError;
    maxPending;
    groups = new Map();
    disposed = false;
    constructor(timing, process, onError = () => { }, maxPending = 100) {
        this.timing = timing;
        this.process = process;
        this.onError = onError;
        this.maxPending = maxPending;
    }
    enqueue(key, value) {
        if (this.disposed)
            return Promise.resolve();
        let group = this.groups.get(key);
        if (!group) {
            group = { items: [], firstAt: Date.now(), lastAt: Date.now(), running: false };
            this.groups.set(key, group);
        }
        if (group.items.length >= Math.max(1, this.maxPending)) {
            this.onError(new Error('消息待处理队列已满，本条未进入AI回合'));
            return Promise.resolve();
        }
        if (!group.items.length)
            group.firstAt = Date.now();
        group.lastAt = Date.now();
        const done = new Promise(resolve => { group.items.push({ value, done: resolve }); });
        if (!group.running)
            this.schedule(key, group);
        return done;
    }
    schedule(key, group) {
        if (group.timer)
            clearTimeout(group.timer);
        const { waitMs, maxWaitMs } = this.timing();
        const due = Math.min(group.lastAt + Math.max(0, waitMs), group.firstAt + Math.max(waitMs, maxWaitMs));
        group.timer = setTimeout(() => { group.timer = undefined; void this.flush(key, group); }, Math.max(0, due - Date.now()));
    }
    async flush(key, group) {
        if (this.disposed || group.running || !group.items.length)
            return;
        group.running = true;
        group.active = new AbortController();
        const items = group.items.splice(0);
        try {
            await this.process(items.map(item => item.value), group.active.signal);
        }
        catch (error) {
            this.onError(error);
        }
        finally {
            for (const item of items)
                item.done();
            group.running = false;
            group.active = undefined;
            if (this.groups.get(key) === group) {
                if (group.items.length)
                    this.schedule(key, group);
                else
                    this.groups.delete(key);
            }
        }
    }
    cancel(key) {
        const group = this.groups.get(key);
        if (!group)
            return;
        group.active?.abort();
        if (group.timer)
            clearTimeout(group.timer);
        for (const item of group.items.splice(0))
            item.done();
        if (!group.running)
            this.groups.delete(key);
    }
    dispose() { this.disposed = true; for (const key of this.groups.keys())
        this.cancel(key); }
}
//# sourceMappingURL=group-inbox.js.map