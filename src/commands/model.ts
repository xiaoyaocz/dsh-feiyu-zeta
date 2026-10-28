/**
 * 模型命令：/model — 查看或切换模型
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { getScopePeer, sendMarkdownChunked } from '../shared/index.ts';

export function modelCommand({ manager, config, isAdministrator }: CommandDeps): CategorizedCommand {
  return {
    name: 'model',
    category: 'agent',
    description: '查看或修改所有QQ群和私聊的公共模型（用法: /model [provider/model]）',
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      const args = (cmdCtx.command?.raw ?? '').trim();
      if (args && !isAdministrator?.(cmdCtx.message.senderId)) return '只有管理员可以修改模型配置。';

      // 无参数：显示当前模型 + 可用模型列表（可点击）
      if (!args) {
        const current = manager.getEffectiveModel(scope, peerId);
        const models = await manager.listAvailableModels();

        // 当前模型展示：优先用别名（name），找不到别名时回退到 provider/model id
        let currentDisplay = '宿主默认配置';
        if (current) {
          const matched = models.find((m) => m.provider === current.provider && m.id === current.model);
          currentDisplay = matched?.name ?? `${current.provider}/${current.model}`;
        }

        const lines: string[] = [
          '### 🤖 模型配置',
          '',
          `**QQ公共默认模型:** ${currentDisplay}`,
        ];
        const status = manager.getStatus(scope, peerId);
        if (status.active) lines.push(`**此会话当前模型:** ${status.provider && status.model ? `${status.provider}/${status.model}` : '尚无请求记录'}`);
        lines.push('所有群聊和私聊共用此默认模型；修改后各会话从下一次请求使用，对话历史保留。');

        if (models.length > 0) {
          lines.push('', '**可用模型（点击切换）:**');
          for (const m of models) {
            const modelPath = `${m.provider}/${m.id}`;
            const displayName = m.name ? `${m.name}` : modelPath;
            lines.push(`<qqbot-cmd-input text="/model ${modelPath}" show="/model ${displayName}"/>`);
          }
        }

        lines.push('', '手动指定: `/model provider/model`');

        await sendMarkdownChunked(cmdCtx, lines.join('\n'), config.textChunkLimit);
        return { kind: 'noop' as const };
      }

      // 解析 provider/model 格式
      let provider: string;
      let model: string;

      if (args.includes('/')) {
        const parts = args.split('/');
        provider = parts[0] ?? '';
        model = parts.slice(1).join('/');
      } else {
        // 仅指定 model 名，provider 从当前路由继承
        const current = manager.getEffectiveModel(scope, peerId);
        provider = current?.provider ?? 'deepseek-official';
        model = args;
      }

      if (!provider || !model) {
        return '用法: /model provider/model\n示例: /model deepseek-official/deepseek-v4-flash';
      }

      await manager.setModelOverride(scope, peerId, { provider, model });
      return `✅ QQ公共默认模型已设为: ${provider}/${model}\n所有群聊和私聊从下一次请求使用；正在进行的回复继续完成，对话历史保留。`;
    },
  };
}
