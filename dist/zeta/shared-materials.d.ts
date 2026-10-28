import type { ModuleHost } from './contracts.ts';
export interface SharedMaterialMigrationReport {
    speech: number;
    images: number;
    deployments: number;
    screenshots: number;
    files: number;
    conflicts: number;
    alreadyMigrated: number;
    websites: number;
}
export declare class SharedMaterialMigrationError extends Error {
    constructor(message: string);
}
/** A stable call identity is separate from the one shared material namespace. */
export declare function materialActorKey(host: ModuleHost, agent: unknown): string;
export declare function legacyMaterialOwner(host: ModuleHost, agent: unknown): string;
export declare function migratedOperationId(dataDir: string, kind: 'speech' | 'images' | 'deployments', legacyOwner: string, operation: string): Promise<string | undefined>;
/** Resolve historical local paths before the caller applies public-root authorization. */
export declare function resolveSharedMaterialFile(dataDir: string, absolutePath: string): Promise<string>;
/** Merge old namespaces without deleting sources, charging providers or sending QQ. */
export declare function migrateSharedMaterials(dataDir: string): Promise<SharedMaterialMigrationReport>;
//# sourceMappingURL=shared-materials.d.ts.map