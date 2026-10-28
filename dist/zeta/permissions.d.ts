/** Trusted QQ request identities. Nothing in a model tool argument can grant a role. */
export interface RequestSource {
    senderId: string;
    messageId: string;
    text: string;
}
export interface RequestAuthority {
    appId: string;
    sources: readonly RequestSource[];
    administrator: boolean;
    senderId?: string;
}
export declare function requestAuthority(appId: string, sources: readonly RequestSource[], administrators: readonly string[]): RequestAuthority;
/** Keep ordinary group chat batched while giving each administrator their own request. */
export declare function splitRequestBatches<T>(items: readonly T[], senderFor: (item: T) => string, isAdministrator: (senderId: string) => boolean): T[][];
export declare function toolDenial(name: string, authority: RequestAuthority | undefined, groupDecision?: 'undecided' | 'reply' | 'skip', actor?: 'qq' | 'life'): string | undefined;
//# sourceMappingURL=permissions.d.ts.map