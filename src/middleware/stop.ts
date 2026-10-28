import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { SessionManager } from '../session/index.ts';

/** Match a whole stop request, never quoted discussion or a request to continue. */
export function isNaturalStop(text: string, appId?: string): boolean {
  const escaped = appId?.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const content = (escaped ? text.replace(new RegExp(`<@!?${escaped}>`, 'gu'), '') : text).trim();
  const clauses = content.split(/[，,。.!！?？；;\s]+/u).filter(Boolean);
  return clauses.length > 0 && clauses.every(clause => /^(?:(?:先)?停(?:停)*|(?:先)?停(?:下|一下)|(?:先)?停止(?:当前|本次)?(?:任务|生成|回复|发送)?|(?:先)?取消(?:当前|本次|刚才)?(?:任务|生成|回复|发送)?|别(?:继续|再做|再发|发|生成)(?:了)?|不要(?:继续|再发|生成)(?:了)?|stop)(?:吧|了|啊|呀|啦)?$/iu.test(clause));
}

export function naturalStop(manager: SessionManager, cancelQueued?: (scope: 'c2c' | 'group', peerId: string) => void) {
  return async (ctx: MiddlewareContext, next: () => Promise<void>): Promise<void> => {
    if (!isNaturalStop(ctx.message.content ?? '', ctx.bot.appId)) { await next(); return; }
    const scope = ctx.message.kind === 'group' ? 'group' : 'c2c';
    const peerId = scope === 'group' ? ctx.message.groupOpenid ?? ctx.message.senderId : ctx.message.senderId;
    cancelQueued?.(scope, peerId);
    manager.interrupt(scope, peerId);
    // Stopping is a control action; it neither queues another turn nor invents
    // a canned assistant acknowledgement on the user's behalf.
    ctx.stop('natural-stop');
  };
}
