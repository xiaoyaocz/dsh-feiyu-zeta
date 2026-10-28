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
import type { ModelRoute } from './types.ts';

/** 日志回调（可选） */
type DebugFn = (msg: string) => void;

/** 隔离偏好文件结构 */
interface PrefsFile {
  overrides: Record<string, ModelRoute>;
  /** sessionKey → 最新 sessionId（fork 后更新，用于重启后恢复到 fork 后的会话） */
  sessionIds: Record<string, string>;
  /** sessionKey → preset id（per-peer preset 覆盖） */
  presets: Record<string, string>;
}

export class PrefsStore {
  /** per-peer 模型偏好（内存态） */
  private overrides = new Map<string, ModelRoute>();
  /** per-peer 最新 sessionId（fork 后更新，内存态） */
  private sessionIds = new Map<string, string>();
  /** per-peer preset 偏好（内存态） */
  private presets = new Map<string, string>();
  /** 隔离偏好文件路径 */
  private readonly prefsPath: string;
  private readonly debugLog?: DebugFn;

  constructor(debugLog?: DebugFn) {
    this.prefsPath = resolve(process.env.DSH_HOME || resolve(homedir(), '.dsh'), 'zeta', 'qq-model-prefs.json');
    this.debugLog = debugLog;
    try { this.load(); } catch (err) { this.debugLog?.(`loadPrefs failed: ${err instanceof Error ? err.message : String(err)}`); }
  }

  // ── Override 操作 ──

  getOverride(sessionKey: string): ModelRoute | undefined {
    this.load();
    const value = this.overrides.get(sessionKey);
    return value ? { ...value } : undefined;
  }

  setOverride(sessionKey: string, route: ModelRoute): void {
    this.load();
    this.overrides.set(sessionKey, { ...route });
    this.write();
  }

  clearOverride(sessionKey: string): boolean {
    this.load();
    const deleted = this.overrides.delete(sessionKey);
    if (deleted) this.write();
    return deleted;
  }

  hasOverride(sessionKey: string): boolean {
    this.load();
    return this.overrides.has(sessionKey);
  }

  // ── SessionId 操作 ──

  getSessionId(sessionKey: string): string | undefined {
    this.load();
    return this.sessionIds.get(sessionKey);
  }

  setSessionId(sessionKey: string, sessionId: string): void {
    this.load();
    this.sessionIds.set(sessionKey, sessionId);
    this.write();
  }

  clearSessionId(sessionKey: string): boolean {
    this.load();
    const deleted = this.sessionIds.delete(sessionKey);
    if (deleted) this.write();
    return deleted;
  }

  // ── Preset 操作 ──

  getPreset(sessionKey: string): string | undefined {
    this.load();
    return this.presets.get(sessionKey);
  }

  setPreset(sessionKey: string, presetId: string): void {
    this.load();
    this.presets.set(sessionKey, presetId);
    this.write();
  }

  clearPreset(sessionKey: string): boolean {
    this.load();
    const deleted = this.presets.delete(sessionKey);
    if (deleted) this.write();
    return deleted;
  }

  // ── 私有方法 ──

  private load(): void {
    const overrides = new Map<string, ModelRoute>(), sessionIds = new Map<string, string>(), presets = new Map<string, string>();
    if (existsSync(this.prefsPath)) {
      const content = readFileSync(this.prefsPath, 'utf8');
      const data = JSON.parse(content) as PrefsFile;
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('QQ公共配置文件格式无效');
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
    this.overrides = overrides; this.sessionIds = sessionIds; this.presets = presets;
  }

  private write(): void {
    const temporary = `${this.prefsPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.prefsPath), { recursive: true });
      const data: PrefsFile = {
        overrides: Object.fromEntries(this.overrides.entries()),
        sessionIds: Object.fromEntries(this.sessionIds.entries()),
        presets: Object.fromEntries(this.presets.entries()),
      };
      writeFileSync(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.prefsPath);
    } catch (err) {
      this.debugLog?.(`writePrefs failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new Error('QQ公共配置保存失败', { cause: err });
    } finally {
      try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* Preserve the original write failure. */ }
    }
  }
}
