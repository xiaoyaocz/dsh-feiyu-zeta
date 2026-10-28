import type { Context } from '@deepseek-ai/cordis';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { BrowserService, registerBrowserTools } from './browser.ts';
import { ImageService, registerImageTools } from './images.ts';
import { PersonaService, registerPersonaTools } from './persona.ts';
import { DeploymentService, registerDeploymentTools } from './deployments.ts';
import type { ZetaRuntime } from './runtime.ts';

export interface ZetaServices {
  browser: BrowserService;
  images: ImageService;
  persona: PersonaService;
  deployments: DeploymentService;
  quiesce(): Promise<void>;
  dispose(): Promise<void>;
}

/** Service secrets never enter tool values, model context or portable materials. */
export async function registerExternalServices(ctx: Context, runtime: ZetaRuntime): Promise<ZetaServices> {
  const persona = new PersonaService(runtime);
  await persona.get();
  const browser = new BrowserService(runtime, () => runtime.state.settings.browser, { beforeBrowse: () => runtime.requireWritable() });
  const images = new ImageService(runtime, () => runtime.state.settings.images, persona, { beforeGenerate: (input, exec) => {
    runtime.requireWritable();
    if (input.send) runtime.targetFor(exec.agent, input.target, 'memes');
  } });
  const temporaryKey = (id: string) => {
    if (!/^[a-zA-Z0-9_-]{1,160}$/u.test(id)) throw new Error('临时部署标识无效');
    return credentialRef(`ZETA_PREVIEW_${id.replaceAll('-', '_')}`);
  };
  const deployments = new DeploymentService(runtime, () => runtime.state.settings.deployments, {
    beforeDeploy: () => runtime.requireWritable(),
    secrets: {
      set: async (id, value) => { await ctx.credentials.set(temporaryKey(id), value); },
      get: async id => (await ctx.credentials.resolve(temporaryKey(id)))?.value,
      delete: async id => { await ctx.credentials.unset(temporaryKey(id)); },
    },
  });
  registerPersonaTools(persona); registerBrowserTools(browser); registerImageTools(images); registerDeploymentTools(deployments);
  ctx.systemPrompt.context({ name: 'zeta:appearance', order: 315, interpolate: false, text: ({ scope }) =>
    runtime.isLifeAgent(scope) || runtime.bindingFor(scope) ? persona.contextText() : '' });
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (runtime.isLifeAgent(agent) || runtime.bindingFor(agent)) await browser.closeForAgent(agent);
  }, { global: true });
  ctx.on('agent/error', ({ agent }) => {
    if (runtime.isLifeAgent(agent) || runtime.bindingFor(agent)) void browser.closeForAgent(agent).catch(() => ctx.logger.warn('云浏览器关闭待重试，请查看外部服务状态'));
  }, { global: true });
  await browser.recover().catch(() => ctx.logger.warn('云浏览器遗留会话尚未清理，请配置凭据后在外部服务页重试'));
  await deployments.recover().catch(() => ctx.logger.warn('临时网页状态恢复尚未完成，请在外部服务页检查已有部署'));
  const services: ZetaServices = { browser, images, persona, deployments, quiesce: async () => {
    await Promise.all([browser.quiesce(), images.quiesce(), deployments.quiesce(), persona.quiesce()]);
  }, dispose: async () => {
    await Promise.allSettled([browser.dispose(), images.dispose(), deployments.dispose(), persona.dispose()]);
  } };
  return services;
}
