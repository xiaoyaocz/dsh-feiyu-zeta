import { getScopePeer, PLUGIN_PACKAGE_NAME, PLUGIN_VERSION } from "../shared/index.js";
/** Report the gateway-authenticated identity for connection diagnostics. */
export function identityCommand({ config }) {
    return { name: 'bot-whoami', category: 'qqbot', description: '查看自己的QQ连接身份', handler: ctx => `机器人 AppID: ${config.appId}\n你的QQ接口身份: ${ctx.message.senderId}\n场景: ${ctx.message.kind === 'group' ? '群聊' : '私聊'}` };
}
/** /bot-ping — 测试当前 dsh 与 QQ 连接的网络延迟 */
export function pingCommand() {
    return {
        name: 'bot-ping',
        category: 'qqbot',
        description: '测试当前 dsh 与 QQ 连接的网络延迟',
        usage: [
            '/bot-ping',
            '',
            '测试 dsh 主机与 QQ 服务器之间的网络延迟。',
            '返回网络传输耗时和插件处理耗时。',
        ].join('\n'),
        handler: (ctx) => {
            const now = Date.now();
            const ts = ctx.message.timestamp;
            const eventTime = ts ? new Date(ts).getTime() : NaN;
            if (Number.isNaN(eventTime)) {
                return '✅ pong!';
            }
            const totalMs = now - eventTime;
            const qqToPlugin = ctx.receivedAt - eventTime;
            const pluginProcess = now - ctx.receivedAt;
            return [
                '✅ pong！',
                `⏱ 延迟: ${totalMs}ms`,
                `  ├ 网络传输: ${qqToPlugin}ms`,
                `  └ 插件处理: ${pluginProcess}ms`,
            ].join('\n');
        },
    };
}
/** /bot-version — 查看版本信息 */
export function versionCommand({ manager }) {
    return {
        name: 'bot-version',
        category: 'qqbot',
        description: '查看版本信息',
        handler: () => {
            const current = manager.getEffectiveModel('c2c', '');
            const modelInfo = current ? `${current.provider}/${current.model}` : '宿主默认';
            return `${PLUGIN_PACKAGE_NAME} v${PLUGIN_VERSION} | model: ${modelInfo}`;
        },
    };
}
/** /stop — 中止当前生成（隐藏） */
export function stopCommand({ manager, cancelQueued }) {
    return {
        name: 'stop',
        category: 'agent',
        description: '中止当前生成',
        hidden: true,
        handler: (cmdCtx) => {
            const { scope, peerId } = getScopePeer(cmdCtx);
            cancelQueued?.(scope, peerId);
            const record = manager.getSessionRecord(scope, peerId);
            const running = record?.agent.status === 'running';
            manager.interrupt(scope, peerId);
            // 会话存在不等于正在生成：只有 agent 处于 running 才算有进行中的回复
            if (!running) {
                return '当前没有进行中的生成';
            }
            // cancel 会让当前轮以 turn/end (kind=interrupted) 收尾，
            // 出站侧据此 flush 已生成的文本并关闭流式会话。
            return '已中止 ⛔';
        },
    };
}
//# sourceMappingURL=misc.js.map