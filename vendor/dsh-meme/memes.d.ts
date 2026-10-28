export interface MemeRow {
  path: string;
  tag: string;
  file_name: string;
  caption: string;
  keywords: string;
  [key: string]: unknown;
}
export class MemesStore {
  constructor(root?: string);
  root: string;
  rows: MemeRow[];
  list(tag?: string | null, query?: string | null, exact?: boolean): { memes: MemeRow[]; tags: string[] };
  search(query: string, n?: number, tag?: string | null): { query: string; tokens: string[]; memes: MemeRow[]; tags: string[] };
  refresh(): void;
  close(): void;
}
export function searchRows<T extends MemeRow>(rows: T[], query: string, limit?: number): { query: string; tokens: string[]; memes: T[] };
export function ensurePackAt(dir: string, meta: { id: string; name: string; description?: string }): string;
export function openIndexWriter(root: string): {
  prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
  exec(sql: string): void;
  close(): void;
};
export function moodNames(): string[];
