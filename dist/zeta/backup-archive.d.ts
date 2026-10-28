import { Readable } from 'node:stream';
export interface ArchiveEntry {
    name: string;
    size: number;
    open: () => Readable;
}
type Entries = AsyncIterable<ArchiveEntry> | Iterable<ArchiveEntry>;
interface WriteResult {
    bytes: number;
    files: number;
}
interface ExtractedFile {
    name: string;
    path: string;
    size: number;
    sha256: string;
}
/** Private backup envelope: magic || salt || IV || encrypted(tar.gz) || GCM tag. */
export declare function writeEncryptedArchive(entries: Entries, destination: string, password: string, signal: AbortSignal): Promise<WriteResult>;
/** Public distributable code archive; all entries must use npm's package/ prefix. */
export declare function writeTarGzip(entries: Entries, destination: string, signal: AbortSignal): Promise<WriteResult>;
/** Extract into the caller's newly-created private empty staging directory. */
export declare function extractEncryptedArchive(source: string, destination: string, password: string, signal: AbortSignal): Promise<{
    files: ExtractedFile[];
    bytes: number;
}>;
export {};
//# sourceMappingURL=backup-archive.d.ts.map