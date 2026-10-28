export declare class GroupInbox<T> {
    private readonly timing;
    private readonly process;
    private readonly onError;
    private readonly maxPending;
    private readonly groups;
    private disposed;
    constructor(timing: () => {
        waitMs: number;
        maxWaitMs: number;
    }, process: (values: T[], signal: AbortSignal) => Promise<void>, onError?: (error: unknown) => void, maxPending?: number);
    enqueue(key: string, value: T): Promise<void>;
    private schedule;
    private flush;
    cancel(key: string): void;
    dispose(): void;
}
//# sourceMappingURL=group-inbox.d.ts.map