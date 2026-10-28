import { mergeSettingsPatch } from '../shared/settings-patch.ts';

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

/** Only locally edited leaves are sent; arrays remain indivisible settings. */
export function settingsChanges(baseline: unknown, draft: unknown): Record<string, unknown> {
  const before = record(baseline) ? baseline : {};
  const after = record(draft) ? draft : {};
  return Object.fromEntries(Object.entries(after).flatMap(([key, value]) => {
    if (JSON.stringify(before[key]) === JSON.stringify(value)) return [];
    if (record(before[key]) && record(value)) {
      const nested = settingsChanges(before[key], value);
      return Object.keys(nested).length ? [[key, nested]] : [];
    }
    return [[key, structuredClone(value)]];
  }));
}

/** Refresh remote values while retaining actual local edits, not stale fields. */
export function rebaseSettingsDraft<T>(baseline: T, draft: T, latest: T): T {
  return mergeSettingsPatch(structuredClone(latest), settingsChanges(baseline, draft)) as T;
}
