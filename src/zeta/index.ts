import type { Context } from '@deepseek-ai/cordis';
import { ZetaState } from './state.ts';
import { ZetaRuntime } from './runtime.ts';
import { registerMemeTools } from './memes.ts';
import { registerSpeechTools } from './speech.ts';
import { registerLife } from './life.ts';
import { registerZetaApi } from './api.ts';
import { registerConversationTools } from './conversations.ts';
import { BackupService } from './backup.ts';
import { registerExternalServices } from './services.ts';
import { registerSettingsTools } from './settings-tools.ts';
import { registerIdentityTools } from './identity-tools.ts';
import { getHistoryStore, historyGroupKey } from '../features/history-store.ts';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

export async function createZeta(ctx: Context, appId: string, directory?: string): Promise<ZetaRuntime> {
  const state = await ZetaState.open(ctx);
  const migration = state.migration;
  if (migration?.status === 'complete' && migration.groupBuffers.length && resolve(directory || `${process.env.DSH_HOME || `${homedir()}/.dsh`}/zeta`) === migration.dataRoot) {
    for (const raw of migration.groupBuffers) {
      const group = raw as { appId: string; peerId: string; entries: Array<{ messageId: string; senderId: string; senderName?: string; content: string; timestamp: number }> };
      const key = historyGroupKey(group.appId, group.peerId); const store = getHistoryStore();
      const current = new Set((await store.list(key, 1000)).map(entry => entry.messageId));
      for (const entry of group.entries) if (!current.has(entry.messageId)) { await store.append(key, entry, Math.max(1, group.entries.length)); current.add(entry.messageId); }
    }
  }
  const runtime = new ZetaRuntime(ctx, state, appId, directory);
  ctx.provide('projectZeta', runtime);
  runtime.install();
  registerIdentityTools(runtime);
  const services = await registerExternalServices(ctx, runtime);
  const removeMaintenance = runtime.onMaintenance(() => services.quiesce());
  registerConversationTools(runtime);
  const memes = registerMemeTools(runtime, { allowedInputFiles: agent => runtime.allowedInputFiles(agent) });
  registerSpeechTools(runtime, () => state.speech, { beforeGenerate: (args, exec) => {
    runtime.requireWritable();
    if (runtime.isLifeAgent(exec.agent) && (!state.settings.life.enabled || !state.settings.life.allowSpeech)) throw new Error('自主语音生成尚未允许');
    if (args.send) runtime.targetFor(exec.agent, args.target, 'speech');
  } });
  const life = registerLife(ctx, state, runtime);
  registerSettingsTools(runtime, () => life.reconcile(), () => services.browser.quiesce());
  ctx.systemPrompt.context({ name: 'zeta:life', order: 330, interpolate: false, text: ({ scope }) => runtime.isLifeAgent(scope) ? life.contextText() : '' });
  const backup = new BackupService(ctx, runtime, memes);
  registerZetaApi(ctx, runtime, state, memes, life, backup, services);
  ctx.effect(() => async () => { removeMaintenance(); await backup.dispose(); await life.dispose(); await services.dispose(); await memes.dispose(); await state.close(); }, 'zeta.resources');
  await life.reconcile().catch(error => ctx.logger.warn(`自主生活未启动：${error instanceof Error ? error.message : '配置不可用'}`));
  return runtime;
}
