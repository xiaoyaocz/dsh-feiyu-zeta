import { ZetaState } from "./state.js";
import { ZetaRuntime } from "./runtime.js";
import { registerMemeTools } from "./memes.js";
import { registerSpeechTools } from "./speech.js";
import { registerLife } from "./life.js";
import { registerZetaApi } from "./api.js";
import { registerConversationTools } from "./conversations.js";
import { BackupService } from "./backup.js";
import { registerExternalServices } from "./services.js";
import { registerSettingsTools } from "./settings-tools.js";
import { registerIdentityTools } from "./identity-tools.js";
import { migrateSharedMaterials } from "./shared-materials.js";
import { getHistoryStore, historyGroupKey } from "../features/history-store.js";
import { resolve } from 'node:path';
import { homedir } from 'node:os';
export async function createZeta(ctx, appId, directory) {
    const state = await ZetaState.open(ctx);
    const migration = state.migration;
    if (migration?.status === 'complete' && migration.groupBuffers.length && resolve(directory || `${process.env.DSH_HOME || `${homedir()}/.dsh`}/zeta`) === migration.dataRoot) {
        for (const raw of migration.groupBuffers) {
            const group = raw;
            const key = historyGroupKey(group.appId, group.peerId);
            const store = getHistoryStore();
            const current = new Set((await store.list(key, 1000)).map(entry => entry.messageId));
            for (const entry of group.entries)
                if (!current.has(entry.messageId)) {
                    await store.append(key, entry, Math.max(1, group.entries.length));
                    current.add(entry.messageId);
                }
        }
    }
    const runtime = new ZetaRuntime(ctx, state, appId, directory);
    try {
        await migrateSharedMaterials(runtime.dataDir);
    }
    catch (error) {
        await state.close();
        throw error;
    }
    ctx.provide('projectZeta', runtime);
    runtime.install();
    registerIdentityTools(runtime);
    const services = await registerExternalServices(ctx, runtime);
    const removeMaintenance = runtime.onMaintenance(() => services.quiesce());
    registerConversationTools(runtime);
    const memes = registerMemeTools(runtime, { allowedInputFiles: agent => runtime.allowedInputFiles(agent) });
    registerSpeechTools(runtime, () => state.speech, { beforeGenerate: (args, exec) => {
            runtime.requireWritable();
            if (runtime.isLifeAgent(exec.agent) && (!state.settings.life.enabled || !state.settings.life.allowSpeech))
                throw new Error('自主语音生成尚未允许');
            if (args.send)
                runtime.targetFor(exec.agent, args.target, 'speech');
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
//# sourceMappingURL=index.js.map