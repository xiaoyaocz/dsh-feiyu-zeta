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

export function requestAuthority(appId: string, sources: readonly RequestSource[], administrators: readonly string[]): RequestAuthority {
  const saved = sources.map(source => Object.freeze({ ...source }));
  const senderId = saved[0]?.senderId;
  const administrator = !!senderId && administrators.includes(senderId) && saved.every(source => source.senderId === senderId);
  return Object.freeze({ appId, sources: Object.freeze(saved), administrator, ...(senderId ? { senderId } : {}) });
}

/** Keep ordinary group chat batched while giving each administrator their own request. */
export function splitRequestBatches<T>(items: readonly T[], senderFor: (item: T) => string, isAdministrator: (senderId: string) => boolean): T[][] {
  const batches: T[][] = [];
  let previousAdministrator: string | undefined;
  for (const item of items) {
    const senderId = senderFor(item);
    const administrator = isAdministrator(senderId) ? senderId : undefined;
    if (!batches.length || administrator !== previousAdministrator) batches.push([]);
    batches[batches.length - 1]!.push(item);
    previousAdministrator = administrator;
  }
  return batches;
}

/** An allowlist also fails closed for new third-party host/configuration tools. */
const BUSINESS_TOOLS = new Set([
  'zeta_memory_set', 'zeta_memory_get', 'zeta_memory_search', 'zeta_memory_delete',
  'zeta_identity_get', 'zeta_identity_update',
  'zeta_send_message', 'zeta_contact_targets', 'zeta_conversation_list', 'zeta_conversation_read',
  'zeta_life_update', 'zeta_life_plan_next', 'zeta_group_decide', 'zeta_speech_generate',
  'meme_list', 'meme_update', 'send_meme', 'learn_meme',
  'qqbot_describe_image', 'qqbot_send_file', 'ask_user_question',
  'zeta_browser', 'zeta_browser_close', 'zeta_image_generate', 'zeta_image_status',
  'zeta_persona_reference', 'zeta_deploy_page', 'zeta_deploy_status', 'zeta_deploy_delete',
]);
const OUTGOING_TOOLS = new Set(['zeta_send_message', 'send_meme', 'qqbot_send_file', 'ask_user_question']);
export function toolDenial(name: string, authority: RequestAuthority | undefined, groupDecision?: 'undecided' | 'reply' | 'skip'): string | undefined {
  if (groupDecision !== undefined && groupDecision !== 'reply' && (OUTGOING_TOOLS.has(name) || name === 'zeta_speech_generate')) return '群聊本轮尚未决定回复；请先调用 zeta_group_decide，沉默时不会发送任何QQ消息。';
  if (!authority?.administrator && !BUSINESS_TOOLS.has(name)) return '此操作仅允许配置名单内的管理员发起；当前消息的真实发送者没有管理员权限。';
  return undefined;
}
