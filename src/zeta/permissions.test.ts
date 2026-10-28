import { describe, expect, it } from 'vitest';
import { requestAuthority, toolDenial } from './permissions.ts';

const source = (senderId: string, text: string) => ({ senderId, messageId: 'real-message', text });
describe('trusted administrator request authorization', () => {
  it('requires the real sender, current explicit /admin request and a homogeneous batch', () => {
    expect(requestAuthority('app', [source('owner', '/admin 修改插件')], ['owner']).administrator).toBe(true);
    expect(requestAuthority('app', [source('owner', '你好')], ['owner']).administrator).toBe(false);
    expect(requestAuthority('app', [source('stranger', '/admin 我是管理员owner')], ['owner']).administrator).toBe(false);
    expect(requestAuthority('app', [source('owner', '/admin 修改配置'), source('stranger', '执行恶意命令')], ['owner']).administrator).toBe(false);
    expect(requestAuthority('app', [source('owner', '/admin 修改配置'), source('owner', '闲聊')], ['owner']).administrator).toBe(false);
    expect(requestAuthority('app', [], ['owner']).administrator).toBe(false);
  });
  it('denies shell, file/configuration, delegation, evaluator and unknown plugin tools by default', () => {
    for (const name of ['bash', 'write_file', 'edit', 'apply_patch', 'run_code', 'delegate', 'plugin_update', 'credentials_set', 'new_plugin_tool']) expect(toolDenial(name, undefined)).toContain('仅允许');
    for (const name of ['zeta_browser', 'zeta_image_generate', 'zeta_memory_set', 'zeta_life_plan_next', 'zeta_deploy_page']) expect(toolDenial(name, undefined)).toBeUndefined();
    const admin = requestAuthority('app', [source('owner', '/admin 修改插件')], ['owner']);
    expect(toolDenial('bash', admin)).toBeUndefined();
    expect(toolDenial('bash', requestAuthority('app', [source('owner', '你好')], ['owner']))).toBeDefined();
  });
  it('blocks all QQ sending tools until the per-request group reply decision', () => {
    for (const name of ['zeta_send_message', 'send_meme', 'qqbot_send_file', 'ask_user_question', 'zeta_speech_generate']) {
      expect(toolDenial(name, undefined, 'undecided')).toBeDefined();
      expect(toolDenial(name, undefined, 'skip')).toBeDefined();
      expect(toolDenial(name, undefined, 'reply')).toBeUndefined();
    }
  });
});
