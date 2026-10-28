import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { Context } from '@deepseek-ai/cordis';
import type { Entry } from '@deepseek-ai/cordis-plugin-loader';
import ScheduleService, { createEveryScheduleRecord, ScheduleId, scheduleDomain, type ScheduleTask } from '@deepseek-ai/dsh-schedule';
import { apply } from './schedule-bridge.ts';
import { ZetaState, type MigrationState } from './state.ts';
import { testDomainContext } from './test-support.ts';

function task(id = 'original-task'): ScheduleTask {
  const lastDelivery = { scheduledAt: '2026-10-27T01:00:00.000Z', deliveredAt: '2026-10-27T01:00:02.000Z', messageId: `${id}-delivery` };
  return scheduleDomain.tables.tasks.valueSchema.parse({
    sessionId: 'original-session',
    record: createEveryScheduleRecord(ScheduleId(id), '继续原来的关注', 3600, Date.parse('2026-10-28T00:00:00.000Z'), '自主生活'),
    status: 'active', lastDelivery,
    deliveryHistory: { records: [{ ...lastDelivery, prompt: '上次实际投递的内容' }], earlierRecordsUnavailable: true, earlierRecordsPruned: true },
  });
}

async function fixture(pending?: ScheduleTask[], existing: ScheduleTask[] = []) {
  const medium = new Map<string, Map<string, unknown>>();
  if (existing.length) medium.set('tasks', new Map(existing.map(value => [value.record.id, structuredClone(value)])));
  const registrations: Array<{ tasks: unknown[]; migration?: MigrationState }> = [];
  const plugin = vi.fn(() => {
    registrations.push(structuredClone({
      tasks: [...(medium.get('tasks')?.values() ?? [])],
      migration: medium.get('migration')?.get('main') as MigrationState | undefined,
    }));
  });
  const warn = vi.fn();
  const configuration = vi.fn<Context['configEditor']['configuration']>(() => []);
  const ctx = Object.assign(testDomainContext(medium), {
    plugin, logger: { warn }, configEditor: { configuration },
  }) as unknown as Context;
  if (pending !== undefined) {
    const state = await ZetaState.open(ctx);
    await state.setMigration({ backupId: 'backup', status: 'complete', dataRoot: '/restored/data', workspaceRoot: '/restored/workspaces',
      restartRequired: true, qqPaused: true, pathMappings: {}, pendingSchedules: pending });
    await state.close();
  }
  return { ctx, medium, plugin, warn, registrations, configuration };
}

function row(id: string, name: string, inherited: Record<string, unknown> = {}, override: Record<string, unknown> = {}, context: object = {}) {
  return { entry: { options: { id, name, disabled: id === 'schedule' }, context } as unknown as Entry, inherited, override };
}

describe('native schedule migration startup bridge', () => {
  it('inherits disabled native settings and resolves their expressions with the owning Loader context', async () => {
    const host = await fixture();
    host.configuration.mockReturnValue([
      row('schedule', '@deepseek-ai/dsh-schedule', { deliveryHistoryDays: 30, deliveryHistoryRecords: 17 },
        { deliveryHistoryDays: { __jsExpr: 'retention.days' } }, { retention: { days: 7 } }),
      row('zeta-schedule-bridge', 'dsh-zeta/schedule-bridge'),
    ]);
    await apply(host.ctx, ScheduleService.Config({}));
    expect(host.plugin).toHaveBeenCalledExactlyOnceWith(ScheduleService, { deliveryHistoryDays: 7, deliveryHistoryRecords: 17 });
  });

  it('lets explicit wrapper fields override native values while wrapper defaults cannot replace omitted fields', async () => {
    const host = await fixture();
    host.configuration.mockReturnValue([
      row('schedule', '@deepseek-ai/dsh-schedule', { deliveryHistoryDays: 7, deliveryHistoryRecords: 17 }),
      row('zeta-schedule-bridge', 'dsh-zeta/schedule-bridge', {}, { deliveryHistoryDays: { __jsExpr: 'retention.days' } }, { retention: { days: 45 } }),
    ]);
    await apply(host.ctx, ScheduleService.Config({ deliveryHistoryDays: 45 }));
    expect(host.plugin).toHaveBeenCalledExactlyOnceWith(ScheduleService, { deliveryHistoryDays: 45, deliveryHistoryRecords: 17 });
  });

  it('uses native retention defaults only when both raw owner configurations omit them', async () => {
    const host = await fixture();
    host.configuration.mockReturnValue([
      row('schedule', '@deepseek-ai/dsh-schedule'), row('zeta-schedule-bridge', 'dsh-zeta/schedule-bridge'),
    ]);
    await apply(host.ctx, ScheduleService.Config({}));
    expect(host.plugin).toHaveBeenCalledExactlyOnceWith(ScheduleService, ScheduleService.Config({}));
  });

  it('persists imported tasks inactive with their original identity and history before registering the native service', async () => {
    const imported = task(); const host = await fixture([imported]);
    const config = { deliveryHistoryDays: 90, deliveryHistoryRecords: 400 };
    await apply(host.ctx, config);
    expect(host.plugin).toHaveBeenCalledExactlyOnceWith(ScheduleService, expect.objectContaining(config));
    expect(host.registrations[0]!.tasks).toStrictEqual([{ ...imported, status: 'inactive' }]);
    expect(host.registrations[0]!.migration).toMatchObject({ pendingSchedules: [], qqPaused: true });
    expect(host.warn).not.toHaveBeenCalled();
  });

  it('accepts the same already-persisted inactive task when a restart repeats an unfinished commit', async () => {
    const imported = task(); const inactive = { ...imported, status: 'inactive' as const };
    const host = await fixture([imported], [inactive]);
    await apply(host.ctx, {});
    await apply(host.ctx, {});
    expect([...host.medium.get('tasks')!.values()]).toStrictEqual([inactive]);
    expect(host.registrations).toHaveLength(2);
    expect(host.registrations.every(value => value.migration?.pendingSchedules.length === 0 && !value.migration.error)).toBe(true);
    expect(host.warn).not.toHaveBeenCalled();
  });

  it('rejects a conflicting task before writing any imported task and persists the migration error before native startup', async () => {
    const imported = task(); const another = task('new-task');
    const existing = scheduleDomain.tables.tasks.valueSchema.parse({ ...imported, record: { ...imported.record, prompt: '目标电脑自己的任务' } });
    const host = await fixture([another, imported], [existing]);
    await apply(host.ctx, {});
    expect([...host.medium.get('tasks')!.values()]).toStrictEqual([existing]);
    expect(host.medium.get('tasks')!.has(another.record.id)).toBe(false);
    expect(host.registrations[0]!.migration).toMatchObject({ pendingSchedules: [another, imported], qqPaused: true });
    expect(host.registrations[0]!.migration?.error).toContain('自动任务恢复未完成');
    expect(host.warn).toHaveBeenCalledOnce();
    expect(host.plugin).toHaveBeenCalledExactlyOnceWith(ScheduleService, expect.any(Object));
  });

  it.each([undefined, []])('delegates normally when no migrated tasks are pending (%s)', async pending => {
    const existing = task('unrelated-existing'); const host = await fixture(pending, [existing]);
    const config = { deliveryHistoryDays: 14 };
    await apply(host.ctx, config);
    expect(host.plugin).toHaveBeenCalledExactlyOnceWith(ScheduleService, expect.objectContaining(config));
    expect(host.registrations[0]!.tasks).toStrictEqual([existing]);
    expect(host.warn).not.toHaveBeenCalled();
  });

  it('disables the original schedule row and inserts the bridge independently in the bundle patch', () => {
    const patches = parseYaml(readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')) as Array<Record<string, unknown>>;
    const originals = patches.filter(row => row.id === 'schedule');
    expect(originals).toHaveLength(1);
    expect(originals[0]).toMatchObject({ id: 'schedule', name: '@deepseek-ai/dsh-schedule', disabled: true });
    const inserted = patches.flatMap(row => Array.isArray(row.insert) ? row.insert as Array<Record<string, unknown>> : []);
    const bridges = inserted.filter(row => row.name === 'dsh-feiyu-zeta/schedule-bridge');
    expect(bridges).toHaveLength(1);
    expect(bridges[0]).toMatchObject({ id: 'zeta-schedule-bridge', name: 'dsh-feiyu-zeta/schedule-bridge' });
  });
});
