import type { ZetaRuntime } from './runtime.ts';
import { registerZetaTool } from './tools.ts';

export function mergeSettingsPatch(current: unknown, patch: unknown, depth = 0): unknown {
  if (depth > 12) throw new Error('设置修改层级过深');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const entries = Object.entries(patch);
  if (entries.some(([key]) => ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('设置字段无效');
  const base = current && typeof current === 'object' && !Array.isArray(current) ? current as Record<string, unknown> : {};
  return Object.fromEntries([...Object.entries(base).filter(([key]) => !Object.hasOwn(patch, key)), ...entries.map(([key, value]) => [key, mergeSettingsPatch(base[key], value, depth + 1)])]);
}

export function registerSettingsTools(runtime: ZetaRuntime, reconcile: () => Promise<unknown>, closeBrowser: () => Promise<void>): void {
  const administrator = (agent: unknown): void => {
    const authority = runtime.authorityFor(agent);
    if (!authority?.administrator || !authority.senderId || !runtime.isAdministrator(authority.senderId)) throw new Error('只有当前真实管理员的 /admin 请求可以读取或修改全局配置');
  };
  registerZetaTool(runtime.ctx, { name: 'zeta_settings_get', description: '管理员读取当前Zeta全局设置（不含密钥）。仅当前管理员明确的/admin请求可调用；先查看实际字段再提交局部修改。', parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: (_args, exec) => { exec.signal.throwIfAborted(); administrator(exec.agent); return { settings: runtime.state.settings }; } });
  registerZetaTool<{ changes: Record<string, unknown> }>(runtime.ctx, { name: 'zeta_settings_update', description: '管理员局部修改Zeta人设、群聊、记忆、语音、浏览器、生图、部署或自主生活设置。未提供的字段保留，数组整体替换。只在当前真实管理员/admin请求中执行；管理员名单和密钥通过DSH管理页面管理。',
    parameters: { type: 'object', properties: { changes: { type: 'object', additionalProperties: true } }, required: ['changes'], additionalProperties: false },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted(); administrator(exec.agent); runtime.requireWritable();
      if (!args.changes || typeof args.changes !== 'object' || Array.isArray(args.changes) || JSON.stringify(args.changes).length > 65536) throw new Error('请提供有效的局部设置对象');
      if (Object.hasOwn(args.changes, 'security')) throw new Error('管理员名单只能由DSH所有者在管理页修改');
      const identityRevision = runtime.state.identity.revision;
      const settings = await runtime.state.setSettings(mergeSettingsPatch(runtime.state.settings, args.changes), { expectedIdentityRevision: identityRevision });
      if (!settings.browser.enabled) await closeBrowser();
      try { await reconcile(); return { settings }; }
      catch { return { settings, warning: '设置已保存，自主活动调度尚未就绪，请在管理页查看状态。' }; }
    } });
}
