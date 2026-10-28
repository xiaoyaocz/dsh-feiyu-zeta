/**
 * 状态命令：/bot-status（QQBot 特有）
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { getScopePeer, formatRelativeTime } from '../shared/index.ts';

/** /bot-status — 查看当前会话状态 */
export function statusCommand({ manager }: CommandDeps): CategorizedCommand {
  return {
    name: 'bot-status',
    category: 'qqbot',
    description: '查看当前会话状态',
    handler: (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      const status = manager.getStatus(scope, peerId);
      const sharedModel = status.defaultModel ? `${status.defaultProvider}/${status.defaultModel}` : '宿主默认';
      if (!status.active) return `当前无活跃会话\nQQ公共默认模型: ${sharedModel}\nQQ新会话公共preset: ${status.defaultPreset ?? '宿主默认'}`;
      const modelInfo = status.model ? `${status.provider}/${status.model}` : '尚无请求记录';
      return [
        '📊 会话状态',
        `会话: ${status.sessionId ? status.sessionId.slice(0, 8) : '—'}`,
        `此会话模型: ${modelInfo}`,
        `QQ公共默认模型: ${sharedModel}（下一次请求使用）`,
        `此会话Preset: ${status.preset ?? '无'}`,
        `QQ新会话公共Preset: ${status.defaultPreset ?? '宿主默认'}（已开始的会话保持原preset）`,
        `消息数: ${status.messageCount ?? 0}`,
        `最后活动: ${formatRelativeTime(status.lastActivity)}`,
      ].join('\n');
    },
  };
}
