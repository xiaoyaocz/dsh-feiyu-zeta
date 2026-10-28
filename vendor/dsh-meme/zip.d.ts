export function zipStore(files: Array<{ name: string; data: Uint8Array }>): Buffer;
export function safeArchiveName(input: string): string;
export function unzipBounded(input: Uint8Array, limits?: { maxEntries?: number; maxEntryBytes?: number; maxTotalBytes?: number; maxArchiveBytes?: number }): Map<string, Buffer>;
