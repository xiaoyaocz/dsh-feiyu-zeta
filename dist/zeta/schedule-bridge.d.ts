import type { Context } from '@deepseek-ai/cordis';
import { type Config as ScheduleConfig } from '@deepseek-ai/dsh-schedule';
export declare const Config: import("@deepseek-ai/schemastery").default<ScheduleConfig>;
export declare const name = "zeta-schedule-bridge";
export declare const inject: string[];
/** Resolve the original owner's settings before the wrapper's schema defaults. */
export declare function readScheduleConfiguration(ctx: Context, fallback?: ScheduleConfig): Required<ScheduleConfig> | undefined;
/** One startup restore seam; all scheduling and execution stay with native DSH. */
export declare function apply(ctx: Context, config: ScheduleConfig): Promise<void>;
//# sourceMappingURL=schedule-bridge.d.ts.map