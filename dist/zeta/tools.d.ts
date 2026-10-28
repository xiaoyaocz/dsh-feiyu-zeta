import type { Context } from '@deepseek-ai/cordis';
import type { ModuleExecution } from './contracts.ts';
export interface ZetaTool<T> {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute(args: T, exec: ModuleExecution): Promise<unknown> | unknown;
}
/** Registration adapter only: dispatch, validation and cancellation remain DSH-owned. */
export declare function registerZetaTool<T>(ctx: Context, definition: ZetaTool<T>): void;
//# sourceMappingURL=tools.d.ts.map