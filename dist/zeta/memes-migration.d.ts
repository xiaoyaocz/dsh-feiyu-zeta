export interface MemeMigrationResult {
    imported: number;
    merged: number;
    alreadyMigrated: number;
}
/** Copy legacy collections without modifying their indexes or images. Row receipts also prevent deleted migrated images being resurrected. */
export declare function migrateLegacyMemeCollections(dataDir: string, sharedRoot: string, maxImageBytes?: number): Promise<MemeMigrationResult>;
//# sourceMappingURL=memes-migration.d.ts.map