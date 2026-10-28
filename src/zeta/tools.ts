import type { Context } from '@deepseek-ai/cordis';
import type { ModuleExecution } from './contracts.ts';

export interface ZetaTool<T> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: T, exec: ModuleExecution): Promise<unknown> | unknown;
}

/** Registration adapter only: dispatch, validation and cancellation remain DSH-owned. */
export function registerZetaTool<T>(ctx: Context, definition: ZetaTool<T>): void {
  ctx.tools.register({ ...definition, output: { schema: {}, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] } } as never);
}
