/** Deep partial settings merge. Arrays replace; neither input is mutated. */
export function mergeSettingsPatch(current, patch, depth = 0) {
    if (depth > 12)
        throw new Error('设置修改层级过深');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch))
        return patch;
    const entries = Object.entries(patch);
    if (entries.some(([key]) => ['__proto__', 'prototype', 'constructor'].includes(key)))
        throw new Error('设置字段无效');
    const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
    return Object.fromEntries([...Object.entries(base).filter(([key]) => !Object.hasOwn(patch, key)), ...entries.map(([key, value]) => [key, mergeSettingsPatch(base[key], value, depth + 1)])]);
}
//# sourceMappingURL=settings-patch.js.map