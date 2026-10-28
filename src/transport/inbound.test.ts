import { describe, expect, it, vi } from 'vitest';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { SessionManager } from '../session/index.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { ZetaRuntime } from '../zeta/runtime.ts';
import { handleInbound } from './inbound.ts';

function context(senderId: string, messageId: string, content: string, state: Record<string, unknown> = {}, attachments?: unknown[]): MiddlewareContext {
  return { message: { kind: 'group', senderId, senderName: senderId, messageId, timestamp: '2026-10-28T12:00:00Z', content, groupOpenid: 'group', attachments }, state, bot: { sendMarkdown: vi.fn() }, signal: new AbortController().signal } as unknown as MiddlewareContext;
}
function fixture() {
  const agent = { followup: vi.fn(), whenIdle: vi.fn().mockResolvedValue(undefined), cancel: vi.fn() };
  const record = { agent, sessionId: 'group-session', scope: 'group', peerId: 'group' };
  const manager = { getOrCreate: vi.fn().mockResolvedValue(record) } as unknown as SessionManager;
  const zeta = { waitForMaintenance: vi.fn(), bindRecord: vi.fn(), noteAttachments: vi.fn(), beginRequest: vi.fn(), endRequest: vi.fn(), state: { consumeMigrationGroup: vi.fn() } } as unknown as ZetaRuntime;
  return { agent, manager, zeta, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, config: { appId: 'bot' } as ImQQBotConfig };
}
describe('group batch identity and media preservation', () => {
  it('retains each real sender/message, pure attachments and quotes without repeating batched history', async () => {
    const f = fixture();
    const a = context('owner', '1', '/admin 修改配置', { mention: { wasMentioned: true }, history: [{ senderId: 'old', content: 'older', timestamp: 1, messageId: '0' }, { senderId: 'owner', content: '/admin 修改配置', messageId: '1' }] });
    const b = context('bob', '2', '', { downloadedFiles: [{ filename: 'image.gif', localPath: 'C:\\media\\image.gif' }], quote: { text: '所引用的内容' } }, [{ content_type: 'image/gif', filename: 'image.gif', url: 'https://qq.example/image.gif', size: 100 }]);
    await handleInbound(a, f.manager, f.config, f.logger, f.zeta, [a, b]);
    const message = f.agent.followup.mock.calls[0]![0] as { content: Array<{ text: string }> };
    const text = message.content.map(block => block.text).join('');
    expect(text).toContain('[owner (owner)]'); expect(text).toContain('[bob (bob)]');
    expect(text).toContain('消息 1'); expect(text).toContain('消息 2'); expect(text).toContain('C:\\media\\image.gif');
    expect(text).toContain('所引用的内容'); expect(text.match(/\/admin 修改配置/gu)).toHaveLength(1);
    expect(f.zeta.beginRequest).toHaveBeenCalledWith(f.agent, [{ senderId: 'owner', messageId: '1', text: '/admin 修改配置' }, { senderId: 'bob', messageId: '2', text: '' }], true);
    expect(f.zeta.noteAttachments).toHaveBeenCalledWith(f.agent, ['C:\\media\\image.gif']); expect(f.zeta.endRequest).toHaveBeenCalledWith(f.agent);
  });
  it('propagates cancellation and always clears request authority when idle rejects', async () => {
    const f = fixture(); const controller = new AbortController();
    const a = context('owner', '1', '/admin 更改插件'); Object.assign(a, { signal: controller.signal });
    f.agent.whenIdle.mockImplementation(async () => { controller.abort(); throw new Error('cancelled'); });
    await handleInbound(a, f.manager, f.config, f.logger, f.zeta);
    expect(f.agent.cancel).toHaveBeenCalled(); expect(f.zeta.endRequest).toHaveBeenCalledWith(f.agent);
  });
  it('sends no group fallback message when session creation fails', async () => {
    const f = fixture(); const a = context('member', '1', '闲聊'); vi.mocked(f.manager.getOrCreate).mockRejectedValue(new Error('offline'));
    await handleInbound(a, f.manager, f.config, f.logger, f.zeta);
    expect(a.bot.sendMarkdown).not.toHaveBeenCalled();
  });
});
