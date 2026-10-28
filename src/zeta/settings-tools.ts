import type { ZetaRuntime } from './runtime.ts';
import { registerZetaTool } from './tools.ts';
export { mergeSettingsPatch } from '../shared/settings-patch.ts';

export function registerSettingsTools(runtime: ZetaRuntime, reconcile: () => Promise<unknown>, closeBrowser: () => Promise<void>): void {
  const administrator = (agent: unknown): void => {
    const authority = runtime.authorityFor(agent);
    if (!authority?.administrator || !authority.senderId || !runtime.isAdministrator(authority.senderId)) throw new Error('只有当前真实管理员发起的请求可以读取或修改全局配置');
  };
  registerZetaTool(runtime.ctx, { name: 'zeta_settings_get', description: '读取当前Zeta全局设置（不含密钥）。根据管理员的正常对话请求调用，后台核验真实发送者身份；先查看实际字段再提交局部修改。', parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: (_args, exec) => { exec.signal.throwIfAborted(); administrator(exec.agent); return { settings: runtime.state.settings }; } });
  registerZetaTool<{ changes: Record<string, unknown> }>(runtime.ctx, { name: 'zeta_settings_update', description: '根据管理员的正常对话请求，局部修改Zeta人设、群聊、记忆、语音、浏览器、生图、部署或自主生活设置。后台核验真实发送者身份；未提供的字段保留，数组整体替换。管理员名单和密钥通过DSH管理页面管理。',
    parameters: { type: 'object', properties: { changes: { type: 'object', additionalProperties: true } }, required: ['changes'], additionalProperties: false },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted(); administrator(exec.agent); runtime.requireWritable();
      if (!args.changes || typeof args.changes !== 'object' || Array.isArray(args.changes) || JSON.stringify(args.changes).length > 65536) throw new Error('请提供有效的局部设置对象');
      if (Object.hasOwn(args.changes, 'security')) throw new Error('管理员名单只能由DSH所有者在管理页修改');
      const identityRevision = runtime.state.identity.revision;
      const settings = await runtime.state.patchSettings(args.changes, { expectedIdentityRevision: identityRevision, signal: exec.signal,
        beforeCommit: () => { exec.signal.throwIfAborted(); administrator(exec.agent); runtime.requireWritable(); } });
      if (!settings.browser.enabled) await closeBrowser();
      try { await reconcile(); return { settings }; }
      catch { return { settings, warning: '设置已保存，自主活动调度尚未就绪，请在管理页查看状态。' }; }
    } });
}
