import { describe, expect, it, vi } from 'vitest';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { SessionManager } from '../session/index.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { ZetaRuntime } from '../zeta/runtime.ts';
import { handleInbound } from './inbound.ts';
import { splitRequestBatches } from '../zeta/permissions.ts';

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
  it('injects parent history once across consecutive member and administrator requests without repeating current messages', async () => {
    const f = fixture();
    const previous = { senderId: 'older-member', senderName: '旧群友', content: '父批次之前的历史', timestamp: 1, messageId: 'older-0' };
    const member = context('member', 'member-1', '成员当前发言', {
      history: [previous], downloadedFiles: [{ filename: 'member.png', localPath: 'C:\\media\\member.png' }],
    }, [{ content_type: 'image/png', filename: 'member.png', url: 'https://qq.example/member.png', size: 100 }]);
    const owner = context('owner', 'owner-2', '请修改配置', {
      mention: { wasMentioned: true },
      history: [previous, { senderId: 'member', senderName: 'member', content: '成员当前发言', timestamp: 2, messageId: 'member-1' }],
      downloadedFiles: [{ filename: 'owner.png', localPath: 'C:\\media\\owner.png' }],
      downloadedQuoteFiles: [{ filename: 'reference.png', localPath: 'C:\\media\\reference.png' }],
      quote: { text: '引用的图片说明', attachments: [{ filename: 'reference.png', contentType: 'image/png' }] },
    }, [{ content_type: 'image/png', filename: 'owner.png', url: 'https://qq.example/owner.png', size: 120 }]);
    Object.assign(owner.message, { senderName: '管理员昵称', timestamp: '2026-10-29T00:01:00Z' });
    const parent = [member, owner];
    const requests = splitRequestBatches(parent, item => item.message.senderId, senderId => senderId === 'owner');
    const excludeIds = new Set(parent.map(item => item.message.messageId));
    expect(requests).toEqual([[member], [owner]]);
    for (const [index, request] of requests.entries()) await handleInbound(request[0]!, f.manager, f.config, f.logger, f.zeta, request, { excludeIds, include: index === 0 });

    const bodies = f.agent.followup.mock.calls.map(([message]) => (message as { content: Array<{ text: string }> }).content.map(block => block.text).join(''));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('父批次之前的历史');
    expect(bodies[0]).toContain('[member (member)] 成员当前发言');
    expect(bodies[0]).toContain('消息 member-1 · 2026-10-28T12:00:00Z');
    expect(bodies[0]).toContain('C:\\media\\member.png');
    expect(bodies[1]).not.toContain('父批次之前的历史');
    expect(bodies[1]).not.toContain('成员当前发言');
    expect(bodies[1]).not.toContain('C:\\media\\member.png');
    expect(bodies[1]).toContain('[管理员昵称 (owner)] 请修改配置');
    expect(bodies[1]).toContain('消息 owner-2 · 2026-10-29T00:01:00Z');
    expect(bodies[1]).toContain('引用的图片说明');
    expect(bodies[1]).toContain('C:\\media\\owner.png');
    expect(bodies[1]).toContain('C:\\media\\reference.png');
    expect(bodies.join('\n').match(/成员当前发言/gu)).toHaveLength(1);
    expect(bodies.join('\n').match(/请修改配置/gu)).toHaveLength(1);
    expect(f.zeta.beginRequest).toHaveBeenNthCalledWith(1, f.agent, [{ senderId: 'member', messageId: 'member-1', text: '成员当前发言' }], true);
    expect(f.zeta.beginRequest).toHaveBeenNthCalledWith(2, f.agent, [{ senderId: 'owner', messageId: 'owner-2', text: '请修改配置' }], true);
    expect(f.zeta.noteAttachments).toHaveBeenNthCalledWith(1, f.agent, ['C:\\media\\member.png']);
    expect(f.zeta.noteAttachments).toHaveBeenNthCalledWith(2, f.agent, ['C:\\media\\owner.png', 'C:\\media\\reference.png']);
    expect(f.zeta.endRequest).toHaveBeenCalledTimes(2);
  });
  it('retains each real sender/message, pure attachments and quotes without repeating batched history', async () => {
    const f = fixture();
    const a = context('owner', '1', '修改配置', { mention: { wasMentioned: true }, history: [{ senderId: 'old', content: 'older', timestamp: 1, messageId: '0' }, { senderId: 'owner', content: '修改配置', messageId: '1' }] });
    const b = context('bob', '2', '', { downloadedFiles: [{ filename: 'image.gif', localPath: 'C:\\media\\image.gif' }], quote: { text: '所引用的内容' } }, [{ content_type: 'image/gif', filename: 'image.gif', url: 'https://qq.example/image.gif', size: 100 }]);
    await handleInbound(a, f.manager, f.config, f.logger, f.zeta, [a, b]);
    const message = f.agent.followup.mock.calls[0]![0] as { content: Array<{ text: string }> };
    const text = message.content.map(block => block.text).join('');
    expect(text).toContain('[owner (owner)]'); expect(text).toContain('[bob (bob)]');
    expect(text).toContain('消息 1'); expect(text).toContain('消息 2'); expect(text).toContain('C:\\media\\image.gif');
    expect(text).toContain('所引用的内容'); expect(text.match(/修改配置/gu)).toHaveLength(1);
    expect(f.zeta.beginRequest).toHaveBeenCalledWith(f.agent, [{ senderId: 'owner', messageId: '1', text: '修改配置' }, { senderId: 'bob', messageId: '2', text: '' }], true);
    expect(f.zeta.noteAttachments).toHaveBeenCalledWith(f.agent, ['C:\\media\\image.gif']); expect(f.zeta.endRequest).toHaveBeenCalledWith(f.agent);
  });
  it('propagates cancellation and always clears request authority when idle rejects', async () => {
    const f = fixture(); const controller = new AbortController();
    const a = context('owner', '1', '更改插件'); Object.assign(a, { signal: controller.signal });
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
