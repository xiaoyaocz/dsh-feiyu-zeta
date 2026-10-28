import type { ModuleHost } from './contracts.ts';
export interface PersonaReference {
    id: string;
    fileName: string;
    filePath: string;
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
    bytes: number;
    description: string;
    createdAt: string;
}
export interface PersonaUpload {
    bytes: Buffer;
    fileName?: string;
    description?: string;
}
export declare function imageMime(bytes: Buffer): PersonaReference['mimeType'];
export declare class PersonaService {
    readonly host: ModuleHost;
    private queue;
    private current?;
    constructor(host: ModuleHost);
    private get directory();
    private get manifest();
    private record;
    private reference;
    private serial;
    get(): Promise<PersonaReference | undefined>;
    contextText(): string;
    upload(input: PersonaUpload): Promise<PersonaReference>;
    setDescription(description: string): Promise<PersonaReference>;
    remove(): Promise<void>;
    referenceDataUrl(): Promise<string | undefined>;
    quiesce(): Promise<void>;
    dispose(): Promise<void>;
}
export declare function registerPersonaTools(service: PersonaService): void;
//# sourceMappingURL=persona.d.ts.map