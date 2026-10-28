import type { ZetaRuntime } from './runtime.ts';
import { registerZetaTool } from './tools.ts';
import type { IdentityUpdate, IdentityView } from './state.ts';

/** Narrow self-authorship capability: it never writes privileges or service settings. */
export function registerIdentityTools(runtime: ZetaRuntime): void {
  const check = (agent: unknown, signal: AbortSignal): void => {
    signal.throwIfAborted(); runtime.requireWritable();
    if (!runtime.isIdentityActor(agent)) throw new Error('只有可信QQ会话或已启用的自主生活会话可以调整自己的身份');
  };
  const current = (value: IdentityView) => ({ name: value.name, persona: value.persona, habits: value.habits, revision: value.revision, updatedAt: value.updatedAt });
  registerZetaTool(runtime.ctx, { name: 'zeta_identity_get', description: '查看自己当前的名字、人设、长期习惯和版本号。所有QQ对话与自主生活共用。需要自我调整前先读取；不会返回其他对话的修改原因或历史。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: (_args, exec) => { check(exec.agent, exec.signal); return current(runtime.state.identity); } });
  registerZetaTool<IdentityUpdate>(runtime.ctx, { name: 'zeta_identity_update', description: '自主调整自己的名字、人设或习惯，无需/admin。仅修改提供的三类身份字段，habits数组整体替换；必须提供刚读取的expected_revision和真实调整原因reason。适合逐渐形成自己的偏好，避免随单条消息频繁重写；不得把他人隐私写进全局身份。此能力不能修改管理员、权限、密钥、预算、插件或人设原图。修改立即持久化，管理页保留最近30次记录。',
    parameters: { type: 'object', properties: {
      expected_revision: { type: 'integer', minimum: 0 }, reason: { type: 'string', minLength: 1, maxLength: 500 },
      name: { type: 'string', minLength: 1, maxLength: 80 }, persona: { type: 'string', minLength: 1, maxLength: 16000 },
      habits: { type: 'array', maxItems: 30, items: { type: 'string', minLength: 1, maxLength: 300 } },
    }, required: ['expected_revision', 'reason'], additionalProperties: false },
    execute: async (args, exec) => {
      check(exec.agent, exec.signal);
      const value = exec.agent as { id?: string; session?: { id?: string } } | undefined;
      return current(await runtime.state.updateIdentity(args, { sourceSessionId: value?.session?.id ?? value?.id, signal: exec.signal, beforeCommit: () => check(exec.agent, exec.signal) }));
    } });
}
