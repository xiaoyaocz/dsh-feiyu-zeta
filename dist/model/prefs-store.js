/**
 * PrefsStore — 公共配置与每聊天 sessionId 持久化
 *
 * 隔离文件 I/O 操作，便于单元测试时 mock。
 * 存储路径：DSH_HOME/zeta/qq-model-prefs.json。旧 peer 模型／preset 保留供迁移。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
export class PrefsStore {
    /** per-peer 模型偏好（内存态） */
    overrides = new Map();
    /** per-peer 最新 sessionId（fork 后更新，内存态） */
    sessionIds = new Map();
    /** per-peer preset 偏好（内存态） */
    presets = new Map();
    /** 隔离偏好文件路径 */
    prefsPath;
    debugLog;
    constructor(debugLog) {
        this.prefsPath = resolve(process.env.DSH_HOME || resolve(homedir(), '.dsh'), 'zeta', 'qq-model-prefs.json');
        this.debugLog = debugLog;
        try {
            this.load();
        }
        catch (err) {
            this.debugLog?.(`loadPrefs failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    // ── Override 操作 ──
    getOverride(sessionKey) {
        this.load();
        const value = this.overrides.get(sessionKey);
        return value ? { ...value } : undefined;
    }
    setOverride(sessionKey, route) {
        this.load();
        this.overrides.set(sessionKey, { ...route });
        this.write();
    }
    clearOverride(sessionKey) {
        this.load();
        const deleted = this.overrides.delete(sessionKey);
        if (deleted)
            this.write();
        return deleted;
    }
    hasOverride(sessionKey) {
        this.load();
        return this.overrides.has(sessionKey);
    }
    // ── SessionId 操作 ──
    getSessionId(sessionKey) {
        this.load();
        return this.sessionIds.get(sessionKey);
    }
    setSessionId(sessionKey, sessionId) {
        this.load();
        this.sessionIds.set(sessionKey, sessionId);
        this.write();
    }
    clearSessionId(sessionKey) {
        this.load();
        const deleted = this.sessionIds.delete(sessionKey);
        if (deleted)
            this.write();
        return deleted;
    }
    // ── Preset 操作 ──
    getPreset(sessionKey) {
        this.load();
        return this.presets.get(sessionKey);
    }
    setPreset(sessionKey, presetId) {
        this.load();
        this.presets.set(sessionKey, presetId);
        this.write();
    }
    clearPreset(sessionKey) {
        this.load();
        const deleted = this.presets.delete(sessionKey);
        if (deleted)
            this.write();
        return deleted;
    }
    // ── 私有方法 ──
    load() {
        const overrides = new Map(), sessionIds = new Map(), presets = new Map();
        if (existsSync(this.prefsPath)) {
            const content = readFileSync(this.prefsPath, 'utf8');
            const data = JSON.parse(content);
            if (!data || typeof data !== 'object' || Array.isArray(data))
                throw new Error('QQ公共配置文件格式无效');
            if (data.overrides && typeof data.overrides === 'object') {
                for (const [key, route] of Object.entries(data.overrides)) {
                    if (route && typeof route.provider === 'string' && route.provider && typeof route.model === 'string' && route.model) {
                        overrides.set(key, { provider: route.provider, model: route.model });
                    }
                }
            }
            if (data.sessionIds && typeof data.sessionIds === 'object') {
                for (const [key, sessionId] of Object.entries(data.sessionIds)) {
                    if (typeof sessionId === 'string' && sessionId) {
                        sessionIds.set(key, sessionId);
                    }
                }
            }
            if (data.presets && typeof data.presets === 'object') {
                for (const [key, presetId] of Object.entries(data.presets)) {
                    if (typeof presetId === 'string' && presetId) {
                        presets.set(key, presetId);
                    }
                }
            }
        }
        // Replacement is essential: another owner may have cleared shared fields.
        this.overrides = overrides;
        this.sessionIds = sessionIds;
        this.presets = presets;
    }
    write() {
        const temporary = `${this.prefsPath}.${process.pid}.${randomUUID()}.tmp`;
        try {
            mkdirSync(dirname(this.prefsPath), { recursive: true });
            const data = {
                overrides: Object.fromEntries(this.overrides.entries()),
                sessionIds: Object.fromEntries(this.sessionIds.entries()),
                presets: Object.fromEntries(this.presets.entries()),
            };
            writeFileSync(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
            renameSync(temporary, this.prefsPath);
        }
        catch (err) {
            this.debugLog?.(`writePrefs failed: ${err instanceof Error ? err.message : String(err)}`);
            throw new Error('QQ公共配置保存失败', { cause: err });
        }
        finally {
            try {
                if (existsSync(temporary))
                    unlinkSync(temporary);
            }
            catch { /* Preserve the original write failure. */ }
        }
    }
}
//# sourceMappingURL=prefs-store.js.map