import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImQQBotConfig } from '../config.ts';
import { ModelResolver, sharedPreferencesKey } from './model-resolver.ts';
import { PrefsStore } from './prefs-store.ts';
import { SettingsReader } from './settings-reader.ts';

const base = realpathSync(tmpdir());
let home: string;
beforeEach(() => { home = mkdtempSync(join(base, 'zeta-shared-config-')); vi.stubEnv('DSH_HOME', home); });
afterEach(() => {
  vi.unstubAllEnvs();
  const path = relative(base, home);
  if (!path || path.startsWith(`..${sep}`) || path === '..' || isAbsolute(path)) throw new Error('Unsafe fixture cleanup');
  rmSync(home, { recursive: true, force: true });
});
const route = (model: string) => ({ provider: 'fixture', model });
function resolver(appId = 'bot', ctx: Record<string, unknown> = {}, config: Partial<ImQQBotConfig> = {}) {
  return new ModelResolver({ get: (name: string) => ctx[name] } as unknown as Context,
    { appId, provider: 'fixture', model: 'configured', ...config } as ImQQBotConfig);
}

describe('one QQ configuration with independent conversation identities', () => {
  it('ignores conflicting legacy peer choices and shares only the matching AppID configuration', () => {
    const legacy = new PrefsStore();
    legacy.setOverride('qqbot:bot:c2c:alice', route('private-old'));
    legacy.setOverride('qqbot:bot:group:room', route('group-old'));
    legacy.setPreset('qqbot:bot:c2c:alice', 'private-preset');
    legacy.setPreset('qqbot:bot:group:room', 'group-preset');
    legacy.setSessionId('qqbot:bot:c2c:alice', 'private-history');
    const shared = resolver(), otherBot = resolver('other-bot');
    expect(shared.getEffectiveRoute('qqbot:bot:c2c:alice')).toEqual(route('configured'));
    expect(shared.getEffectiveRoute('qqbot:bot:group:room')).toEqual(route('configured'));
    expect(shared.getPreset('qqbot:bot:c2c:alice')).toBeUndefined();
    shared.setOverride('qqbot:bot:c2c:alice', route('new-shared'));
    shared.setPreset('qqbot:bot:group:room', 'shared-preset');
    expect(shared.getEffectiveRoute('qqbot:bot:group:room')).toEqual(route('new-shared'));
    expect(shared.getResumeRoute('qqbot:bot:c2c:alice')).toEqual(route('new-shared'));
    expect(shared.getPreset('qqbot:bot:c2c:alice')).toBe('shared-preset');
    expect(otherBot.getEffectiveRoute('qqbot:other-bot:group:room')).toEqual(route('configured'));
    expect(otherBot.getPreset('qqbot:other-bot:c2c:alice')).toBeUndefined();
    const persisted = JSON.parse(readFileSync(join(home, 'zeta', 'qq-model-prefs.json'), 'utf8'));
    expect(persisted.overrides).toEqual({ 'qqbot:bot:c2c:alice': route('private-old'), 'qqbot:bot:group:room': route('group-old'), [sharedPreferencesKey('bot')]: route('new-shared') });
    expect(persisted.presets['qqbot:bot:group:room']).toBe('group-preset');
    expect(persisted.sessionIds).toEqual({ 'qqbot:bot:c2c:alice': 'private-history' });
  });

  it('reloads shared deletions before any sessionId write, without resurrecting an old manager cache', () => {
    const manager = resolver(); manager.setOverride('private', route('from-command')); manager.setPreset('private', 'from-command');
    const page = new PrefsStore(); page.clearOverride(sharedPreferencesKey('bot')); page.clearPreset(sharedPreferencesKey('bot'));
    expect(manager.getEffectiveRoute('group')).toEqual(route('configured')); expect(manager.getPreset('group')).toBeUndefined();
    manager.setSessionId('qqbot:bot:group:room', 'same-chat-history');
    const fresh = new PrefsStore();
    expect(fresh.getOverride(sharedPreferencesKey('bot'))).toBeUndefined(); expect(fresh.getPreset(sharedPreferencesKey('bot'))).toBeUndefined();
    expect(fresh.getSessionId('qqbot:bot:group:room')).toBe('same-chat-history');
  });

  it('does not lose another AppID write from a second store instance', () => {
    const first = resolver('first'), second = resolver('second');
    first.setOverride('private', route('first-model')); second.setOverride('group', route('second-model'));
    first.setSessionId('qqbot:first:c2c:alice', 'first-history');
    expect(first.getEffectiveRoute('group')).toEqual(route('first-model'));
    expect(second.getEffectiveRoute('private')).toEqual(route('second-model'));
    expect(new PrefsStore().getSessionId('qqbot:first:c2c:alice')).toBe('first-history');
  });

  it('reads the live host selection before legacy YAML and observes later host changes', () => {
    writeFileSync(join(home, 'settings.yaml'), 'agent-default-model:\n  provider: fixture\n  model: yaml-old\n');
    let selected = route('host-first');
    const shared = resolver('bot', { agentDefaultModel: { currentSelection: () => selected } }, { provider: undefined, model: undefined });
    expect(shared.getEffectiveRoute('private')).toEqual(route('host-first'));
    selected = route('host-next'); expect(shared.getEffectiveRoute('group')).toEqual(route('host-next'));
  });

  it('treats settings.yaml as a live legacy fallback instead of caching its first read or absence', () => {
    const settings = new SettingsReader(); expect(settings.readDefaultRoute()).toBeUndefined();
    writeFileSync(join(home, 'settings.yaml'), 'agent-default-model:\n  provider: fixture\n  model: first\n');
    expect(settings.readDefaultRoute()).toEqual(route('first'));
    writeFileSync(join(home, 'settings.yaml'), 'agent-default-model:\n  provider: fixture\n  model: next\n');
    expect(settings.readDefaultRoute()).toEqual(route('next'));
    unlinkSync(join(home, 'settings.yaml')); expect(settings.readDefaultRoute()).toBeUndefined();
  });

  it('reports persistence failures rather than claiming that a public preference was saved', () => {
    writeFileSync(join(home, 'zeta'), 'file blocking the directory');
    expect(() => resolver().setOverride('private', route('must-not-be-saved'))).toThrow('保存失败');
    expect(readFileSync(join(home, 'zeta'), 'utf8')).toBe('file blocking the directory');
  });

  it('never replaces malformed preferences while trying to update a conversation identity', () => {
    mkdirSync(join(home, 'zeta')); const file = join(home, 'zeta', 'qq-model-prefs.json'); writeFileSync(file, '{broken');
    const store = new PrefsStore(); expect(() => store.setSessionId('qqbot:bot:c2c:alice', 'new')).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('{broken');
  });
});
