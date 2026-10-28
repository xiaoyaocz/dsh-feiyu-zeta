import type { Context } from '@deepseek-ai/cordis';
import { BrowserService } from './browser.ts';
import { ImageService } from './images.ts';
import { PersonaService } from './persona.ts';
import { DeploymentService } from './deployments.ts';
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
export declare function registerExternalServices(ctx: Context, runtime: ZetaRuntime): Promise<ZetaServices>;
//# sourceMappingURL=services.d.ts.map