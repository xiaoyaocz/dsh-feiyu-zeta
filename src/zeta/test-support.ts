import type { Context } from '@deepseek-ai/cordis';

export function testDomainContext(persisted = new Map<string, Map<string, unknown>>()): Context {
  let chain = Promise.resolve();
  return { storageDomain: { open: async () => ({ table(name: string) {
    if (!persisted.has(name)) persisted.set(name, new Map());
    const records = persisted.get(name)!;
    const queued = <T>(run: () => T): Promise<T> => { const task = chain.then(run); chain = task.then(() => undefined, () => undefined); return task; };
    return { get: (key: string) => records.get(key), keys: () => [...records.keys()][Symbol.iterator](), entries: () => [...records.entries()][Symbol.iterator](), get size() { return records.size; }, put: (key: string, value: unknown) => queued(() => { records.set(key, structuredClone(value)); }), delete: (key: string) => queued(() => records.delete(key)), update: (key: string, fn: (value: unknown) => unknown) => queued(() => { if (!records.has(key)) throw new Error('missing-key'); const value = fn(records.get(key)); records.set(key, structuredClone(value)); return value; }) };
  }, close: async () => { await chain; } }) } } as unknown as Context;
}
