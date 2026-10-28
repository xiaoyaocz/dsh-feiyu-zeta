import type { Context } from '@deepseek-ai/cordis';
import { interpolate } from '@deepseek-ai/cordis-plugin-loader';
import type {} from '@deepseek-ai/dsh-config-editor';
import ScheduleService, { scheduleDomain, type Config as ScheduleConfig } from '@deepseek-ai/dsh-schedule';
import { ZetaState } from './state.ts';
import { PLUGIN_PACKAGE_ALIASES } from '../shared/utils.ts';

export const Config = ScheduleService.Config;
export const name = 'zeta-schedule-bridge';
export const inject = [...new Set([...ScheduleService.inject, 'storageDomain', 'configEditor'])];

/** Resolve the original owner's settings before the wrapper's schema defaults. */
export function readScheduleConfiguration(ctx: Context, fallback?: ScheduleConfig): Required<ScheduleConfig> | undefined {
  const rows = ctx.configEditor.configuration();
  const native = rows.find(row => row.entry.options.id === 'schedule' && row.entry.options.name === '@deepseek-ai/dsh-schedule');
  const bridge = rows.find(row => row.entry.options.id === 'zeta-schedule-bridge' && PLUGIN_PACKAGE_ALIASES.some(name => row.entry.options.name === `${name}/schedule-bridge`));
  if (!native && !bridge && !fallback) return undefined;
  const values = (row: NonNullable<typeof native>): ScheduleConfig => {
    const raw = interpolate(row.entry.context, { ...row.inherited, ...row.override }) as ScheduleConfig;
    return Object.fromEntries(['deliveryHistoryDays', 'deliveryHistoryRecords'].filter(key => Object.hasOwn(raw, key))
      .map(key => [key, raw[key as keyof ScheduleConfig]]));
  };
  // `config` passed to apply() already contains wrapper defaults. Only raw
  // explicit wrapper values may replace the disabled original row's values.
  return ScheduleService.Config({ ...(native ? values(native) : {}), ...(bridge ? values(bridge) : fallback ?? {}) }) as Required<ScheduleConfig>;
}

/** One startup restore seam; all scheduling and execution stay with native DSH. */
export async function apply(ctx: Context, config: ScheduleConfig): Promise<void> {
  const effective = readScheduleConfiguration(ctx, config)!;
  const state = await ZetaState.open(ctx);
  try {
    const migration = state.migration;
    if (migration?.status === 'complete' && migration.pendingSchedules.length) {
      const tasks = migration.pendingSchedules.map(value => scheduleDomain.tables.tasks.valueSchema.parse(value));
      const domain = await ctx.storageDomain.open(scheduleDomain);
      try {
        const table = domain.table('tasks');
        // Check every collision before any native task is committed.
        for (const task of tasks) {
          const old = table.get(task.record.id);
          if (old && JSON.stringify(old) !== JSON.stringify({ ...task, status: 'inactive' })) throw new Error('恢复的自动任务与目标电脑已有任务冲突');
        }
        for (const task of tasks) if (!table.get(task.record.id)) await table.put(task.record.id, { ...task, status: 'inactive' });
        await state.setMigration({ ...migration, pendingSchedules: [], error: undefined });
      } finally { await domain.close(); }
    }
  } catch {
    const migration = state.migration;
    if (migration) await state.setMigration({ ...migration, error: '自动任务恢复未完成，请在备份页重新校验迁移包；当前QQ与自主生活保持暂停' });
    ctx.logger.warn('dsh-feiyu-zeta自动任务迁移未完成，未启动导入的任务。');
  } finally { await state.close(); }
  ctx.plugin(ScheduleService, effective);
}
