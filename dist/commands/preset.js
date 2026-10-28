import { getScopePeer, sendMarkdownChunked } from "../shared/index.js";
export function presetCommand({ manager, config, isAdministrator }) {
    return {
        name: 'preset',
        category: 'agent',
        description: '查看或修改所有QQ新会话的公共preset（用法: /preset [id]）',
        handler: async (cmdCtx) => {
            const { scope, peerId } = getScopePeer(cmdCtx);
            const args = (cmdCtx.command?.raw ?? '').trim();
            if (args && !isAdministrator?.(cmdCtx.message.senderId))
                return '只有管理员可以修改Agent配置。';
            // 无参数：列出可用 preset + 当前
            if (!args) {
                const presets = await manager.listPresets();
                if (presets.length === 0) {
                    return '当前部署无可用的 agent preset';
                }
                const status = manager.getStatus(scope, peerId);
                const defaultId = manager.getEffectivePreset(scope, peerId);
                const lines = ['### 🧩 Agent Preset', ''];
                lines.push(`**QQ新会话公共默认:** ${defaultId ?? '宿主默认'}`);
                if (status.active)
                    lines.push(`**此会话已使用:** ${status.preset ?? '无'}`);
                lines.push('所有群聊和私聊的新会话共用此默认；已开始的会话保留原preset和历史。');
                lines.push('', '**可用 preset（点击切换）:**');
                for (const p of presets) {
                    const display = p.name ? `${p.name} (${p.id})` : p.id;
                    lines.push(`<qqbot-cmd-input text="/preset ${p.id}" show="/preset ${display}"/>`);
                }
                lines.push('', '手动指定: `/preset <id>`，重置默认: `/preset reset`');
                await sendMarkdownChunked(cmdCtx, lines.join('\n'), config.textChunkLimit);
                return { kind: 'noop' };
            }
            // reset / default：清除公共覆盖，回到配置／宿主默认
            if (args === 'reset' || args === 'default') {
                const outcome = await manager.clearPresetOverride(scope, peerId);
                return outcome.ok ? '✅ 已重置QQ公共默认preset；所有群聊和私聊的新会话生效，已开始的会话保持原preset。' : '重置失败';
            }
            // 切换到指定 preset
            const outcome = await manager.setPresetOverride(scope, peerId, args);
            if (!outcome.ok) {
                switch (outcome.reason) {
                    case 'unavailable':
                        return '当前部署不支持 agent preset（agentPresets 服务未注入）';
                    case 'unknown-preset':
                        return `未知 preset: ${args}`;
                    case 'broken':
                        return `preset ${args} 加载失败: ${outcome.message ?? '未知错误'}`;
                    default:
                        return `切换失败: ${outcome.message ?? '未知错误'}`;
                }
            }
            return `✅ QQ新会话公共preset已设为: ${outcome.presetId ?? args}\n所有群聊和私聊的新会话生效；当前会话保持原preset及历史，发送 /new 后使用新默认。`;
        },
    };
}
//# sourceMappingURL=preset.js.map