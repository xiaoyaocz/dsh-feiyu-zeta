/** Deep partial settings merge. Arrays replace; neither input is mutated. */
export function mergeSettingsPatch(current: unknown, patch: unknown, depth = 0): unknown {
  if (depth > 12) throw new Error('设置修改层级过深');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const entries = Object.entries(patch);
  if (entries.some(([key]) => ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('设置字段无效');
  const base = current && typeof current === 'object' && !Array.isArray(current) ? current as Record<string, unknown> : {};
  return Object.fromEntries([...Object.entries(base).filter(([key]) => !Object.hasOwn(patch, key)), ...entries.map(([key, value]) => [key, mergeSettingsPatch(base[key], value, depth + 1)])]);
}
