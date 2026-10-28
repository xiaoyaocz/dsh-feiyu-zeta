import { createElement as h, useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { ZETA_API_PATH } from '../shared/http-paths.ts';

type Provider = 'mimo' | 'minimax';
interface ProviderSettings { model: string; voice: string; speed: number; emotion?: string }
interface Settings {
  name: string;
  persona: string;
  habits: string[];
  security: { administrators: string[] };
  group: { waitMs: number; maxWaitMs: number };
  browser: { enabled: boolean; accountId: string; maxConcurrent: number; maxSessionMs: number; idleTimeoutMs: number; dailyBudgetMs: number; actionTimeoutMs: number };
  images: { enabled: boolean; model: string; resolution: '1K' | '2K' | '4K'; timeoutMs: number; pollIntervalMs: number; maxWaitMs: number; maxPromptCharacters: number; maxImageBytes: number; dailyLimit: number };
  deployments: { enabled: boolean; acceptedTerms: boolean; maxFiles: number; maxFileBytes: number; maxTotalBytes: number; timeoutMs: number; maxActive: number };
  memory: { enabled: boolean; maxItems: number; maxValueChars: number; injectItems: number; injectChars: number };
  conversations: { allowCrossSend: boolean; allowCrossRead: boolean };
  speech: { enabled: boolean; provider: Provider; mimo: ProviderSettings; minimax: ProviderSettings; maxTextCharacters: number; timeoutMs: number };
  life: { enabled: boolean; intervalMinutes: number; minIntervalMinutes: number; maxDailyRuns: number; timeZone: string; quietStart: number; quietEnd: number; targets: string[]; readTargets: string[]; allowContact: boolean; allowMemes: boolean; allowSpeech: boolean; dailyContactLimit: number; contactCooldownMinutes: number; interests: string };
}
interface Binding { key: string; appId: string; scope: 'c2c' | 'group'; peerId: string; sessionId: string; title?: string }
interface Conversation { key: string; appId: string; scope: 'c2c' | 'group'; peerId: string; target: string; title?: string; alias?: string; sessionId?: string; lastSeenAt: number; active: boolean }
interface Life { status: string; summary: string; focus: string; lastRunAt: number; lastFinishedAt: number; contactCount: number; nextWakeAt?: number; nextWakeReason?: string; runCount?: number; error?: string }
interface IdentityFields { name: string; persona: string; habits: string[] }
interface IdentityChange { revision: number; reason: string; createdAt: string; sourceSessionId?: string; before: IdentityFields; after: IdentityFields }
interface IdentitySummary { revision: number; updatedAt?: string; history: IdentityChange[] }
interface IdentitySnapshot extends IdentityFields, IdentitySummary {}
interface AdministratorCandidate { senderId: string; name?: string; scope?: 'c2c' | 'group'; peerId?: string; lastSeenAt: number; observed: boolean }
interface State { settings: Settings; identity?: IdentitySummary; administratorCandidates?: AdministratorCandidate[]; credentials: Record<Provider | 'cloudflare' | 'apimart', boolean>; life: Life; bindings: Binding[]; conversations: Conversation[]; memoryCount: number; version: string }
interface Memory { key: string; value: string; tags: string[]; pinned: boolean; createdAt: string; updatedAt: string }
interface Meme { id: string; caption: string; tag?: string; keywords?: string | string[]; fileName?: string; builtin?: boolean }
interface MemeImport { imported: number; skipped: number; complete: boolean; cancelled?: boolean; error?: string }
interface PersonaReference { id: string; fileName: string; mimeType: string; bytes: number; description: string; createdAt: string }
interface Speech { provider: Provider; model: string; voice: string; fileName: string; bytes: number; characters: number; createdAt: string; generation: string; delivery: string; notice?: string }
interface BackupPreview { formatVersion: number; pluginVersion: string; dshVersion: string; createdAt: string; sessions: number; memoryItems: number; conversations: number; files: number; bytes: number; includesCredentials: boolean; warnings: string[]; canRestore: boolean; conflicts: string[] }
interface PreparedBackup { token: string; preview: BackupPreview }
interface BackupRestored { restored: true; restartRequired: true; sessions: number; files: number; warnings: string[] }
interface BackupStatus { restartRequired: boolean; canActivate: boolean; maintenance: boolean; pendingRestore: boolean }
type Tab = 'overview' | 'persona' | 'conversations' | 'memory' | 'memes' | 'speech' | 'life' | 'security' | 'services' | 'backup';
type Feedback = (message: string, error?: boolean) => void;

const API = ZETA_API_PATH;
const PLUGIN_NAME = 'dsh-feiyu-zeta';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: '概览' }, { id: 'persona', label: '人设' }, { id: 'conversations', label: '会话' }, { id: 'memory', label: '记忆' },
  { id: 'memes', label: '表情' }, { id: 'speech', label: '语音' }, { id: 'life', label: '自主生活' }, { id: 'security', label: '管理员与群聊' }, { id: 'services', label: '外部服务' }, { id: 'backup', label: '备份迁移' },
];
const PROVIDER_NAME: Record<Provider, string> = { mimo: 'MiMo', minimax: 'MiniMax' };
const EMOTIONS = [{ value: 'auto', label: '自动' }, { value: 'happy', label: '开心' }, { value: 'sad', label: '难过' }, { value: 'angry', label: '生气' }, { value: 'fearful', label: '害怕' }, { value: 'disgusted', label: '嫌弃' }, { value: 'surprised', label: '惊讶' }, { value: 'calm', label: '平静' }];

async function responseError(response: Response): Promise<Error> {
  let message = '操作未完成，请检查连接后重试。';
  try {
    const value: unknown = await response.json();
    if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string') message = value.error.slice(0, 2000);
  } catch { /* HTML or transport bodies are not user-facing errors. */ }
  return new Error(message);
}

async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal, headers?: Record<string, string>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { method, credentials: 'same-origin', cache: 'no-store', signal,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`暂时无法连接 ${PLUGIN_NAME}，请稍后刷新。`);
  }
  if (!response.ok) throw await responseError(response);
  if (response.status === 204) return undefined as T;
  try { return await response.json() as T; }
  catch { throw new Error('服务返回的数据无法读取，请刷新后重试。'); }
}

function message(error: unknown): string { return error instanceof Error ? error.message : '操作未完成，请稍后重试。'; }
function date(value: string | number | undefined): string {
  if (!value) return '尚无记录';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '时间未知' : parsed.toLocaleString('zh-CN', { hour12: false });
}
function keywords(value: string | string[] | undefined): string { return Array.isArray(value) ? value.join('，') : value ?? ''; }
function splitTags(value: string): string[] { return [...new Set(value.split(/[\s,，]+/u).map(part => part.trim()).filter(Boolean))]; }
function targetLines(value: string): string[] { return [...new Set(value.split(/\r?\n/u).map(part => part.trim()).filter(Boolean))]; }
function conversationName(value: Conversation): string { return value.alias || value.title || `${value.scope === 'group' ? '群聊' : '私聊'} ${value.peerId}`; }
function knownConversations(state: State): Conversation[] {
  const values = new Map<string, Conversation>();
  for (const binding of state.conversations === undefined ? state.bindings : []) {
    const target = `${binding.scope}:${binding.peerId}`;
    values.set(target, { ...binding, target, lastSeenAt: 0, active: true });
  }
  for (const conversation of state.conversations ?? []) values.set(conversation.target, conversation);
  return [...values.values()].sort((a, b) => Number(b.active) - Number(a.active) || b.lastSeenAt - a.lastSeenAt || conversationName(a).localeCompare(conversationName(b), 'zh-CN'));
}
function mediaPath(kind: 'meme' | 'speech', id: string): string { return `${API}/media?${new URLSearchParams({ kind, id })}`; }

function useTask(feedback: Feedback): { busy: boolean; run: (work: () => Promise<void>) => Promise<void> } {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const run = useCallback(async (work: () => Promise<void>): Promise<void> => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try { await work(); } catch (error) { feedback(message(error), true); }
    finally { pending.current = false; setBusy(false); }
  }, [feedback]);
  return { busy, run };
}

function useStyles(): void {
  useEffect(() => {
    if (typeof document === 'undefined' || document.getElementById('zeta-settings-style')) return;
    const style = document.createElement('style'); style.id = 'zeta-settings-style';
    style.textContent = `
.zeta-settings{color:var(--dsw-alias-label-primary,#20242c);font:13px/1.6 system-ui,sans-serif;max-width:960px;width:100%;min-width:0;margin:22px auto 0;padding-top:18px;border-top:1px solid var(--dsw-alias-border-l2,#ddd);box-sizing:border-box}
.zeta-settings *{box-sizing:border-box}.zeta-settings h2,.zeta-settings h3,.zeta-settings p{margin:0}.zeta-settings h2{font-size:20px;letter-spacing:-.4px}.zeta-settings h3{font-size:14px;font-weight:600}
.zeta-settings button,.zeta-settings input,.zeta-settings textarea,.zeta-settings select{font:inherit;color:inherit}.zeta-settings button{cursor:pointer}.zeta-settings button:disabled{cursor:default;opacity:.5}
.zeta-settings input,.zeta-settings select,.zeta-settings textarea{max-width:100%;width:100%;min-width:0;border:1px solid var(--dsw-alias-border-l4,#d8dbe1);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#fff);padding:8px 10px;outline:none}
.zeta-settings textarea{resize:vertical;line-height:1.65;min-height:94px}.zeta-settings input:focus,.zeta-settings textarea:focus,.zeta-settings select:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.zeta-settings button:focus-visible,.zeta-settings a:focus-visible,.zeta-settings summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:3px}.zeta-settings input[type=checkbox]{width:16px;height:16px;flex:0 0 16px;accent-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.zeta-settings fieldset{border:0;margin:0;padding:0;min-width:0}.zeta-settings .zs-head,.zeta-settings .zs-row,.zeta-settings .zs-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.zeta-settings .zs-head{justify-content:space-between;margin-bottom:16px}
.zeta-settings .zs-stack{display:flex;flex-direction:column;gap:16px;min-width:0}.zeta-settings .zs-muted{color:var(--dsw-alias-label-secondary,#697280);font-size:12px;overflow-wrap:anywhere}.zeta-settings .zs-small{font-size:11px}
.zeta-settings .zs-tabs{display:flex;gap:4px;overflow-x:auto;padding:4px;margin-bottom:18px;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover,#f2f3f6)}
.zeta-settings .zs-tab{flex:1 0 auto;border:0;border-radius:7px;padding:8px 12px;background:transparent;color:var(--dsw-alias-label-secondary,#6a717d);white-space:nowrap}.zeta-settings .zs-tab[aria-selected=true]{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#20242c);box-shadow:0 1px 4px #0000000a}
.zeta-settings .zs-button{border:1px solid var(--dsw-alias-border-l4,#d7dbe2);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#fff);padding:7px 12px;white-space:normal;overflow-wrap:anywhere}.zeta-settings .zs-primary{background:var(--dsw-alias-label-primary,#20242c);color:var(--dsw-alias-bg-layer-3,#fff);border-color:transparent}.zeta-settings .zs-danger{color:var(--dsw-alias-state-error-primary,#bd3131)}
.zeta-settings .zs-card{border:1px solid var(--dsw-alias-border-l2,#e2e5eb);border-radius:12px;padding:16px;min-width:0;background:var(--dsw-alias-bg-layer-2,transparent)}
.zeta-settings .zs-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.zeta-settings .zs-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}.zeta-settings .zs-stat{font-size:20px;font-weight:600;margin-top:6px;overflow-wrap:anywhere}
.zeta-settings .zs-field{display:flex;flex-direction:column;gap:6px;min-width:0}.zeta-settings .zs-label{font-weight:500}.zeta-settings .zs-check{display:flex;align-items:flex-start;gap:9px;cursor:pointer;min-width:0}.zeta-settings .zs-check input{margin-top:3px}.zeta-settings .zs-check span{min-width:0;overflow-wrap:anywhere}.zeta-settings .zs-check small{display:block;color:var(--dsw-alias-label-secondary,#697280);font-size:12px;font-weight:400;margin-top:2px}
.zeta-settings .zs-notice{padding:10px 12px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,#f2f4f7);margin-bottom:14px;overflow-wrap:anywhere}.zeta-settings .zs-error{color:var(--dsw-alias-state-error-primary,#bd3131);border:1px solid currentColor}
.zeta-settings .zs-empty{padding:26px 12px;text-align:center;color:var(--dsw-alias-label-secondary,#697280)}.zeta-settings .zs-body{white-space:pre-wrap;overflow-wrap:anywhere}.zeta-settings .zs-record{padding:13px 0;border-bottom:1px solid var(--dsw-alias-border-l2,#e3e6eb)}.zeta-settings .zs-record:last-child{border-bottom:0}.zeta-settings .zs-record-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:6px}.zeta-settings .zs-record-title{font-weight:600;overflow-wrap:anywhere;min-width:0}.zeta-settings .zs-badge{display:inline-block;padding:2px 7px;border-radius:99px;font-size:11px;background:var(--dsw-alias-interactive-bg-hover,#eef1f6);font-weight:400}
.zeta-settings .zs-search{display:flex;align-items:center;gap:8px}.zeta-settings .zs-search input{flex:1}.zeta-settings .zs-memes{display:grid;grid-template-columns:repeat(auto-fill,minmax(125px,1fr));gap:12px}.zeta-settings .zs-meme{display:flex;flex-direction:column;gap:8px;text-align:left;border:1px solid var(--dsw-alias-border-l2,#e0e4eb);border-radius:10px;padding:8px;background:var(--dsw-alias-bg-layer-3,#fff);min-width:0}.zeta-settings .zs-meme[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}.zeta-settings .zs-picture{width:100%;aspect-ratio:1;display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover,#f5f6f8)}.zeta-settings .zs-picture img{display:block;max-width:100%;max-height:100%;object-fit:contain}.zeta-settings .zs-caption{font-size:12px;overflow-wrap:anywhere}.zeta-settings .zs-preview{max-width:280px;width:100%;margin:auto}.zeta-settings audio{width:100%;max-width:100%}.zeta-settings .zs-loading{padding:24px;text-align:center}.zeta-settings details>summary{cursor:pointer;font-weight:500}.zeta-settings details[open]>summary{margin-bottom:12px}.zeta-settings .zs-spacer{flex:1}.zeta-settings .zs-code{font-family:ui-monospace,monospace;font-size:11px;overflow-wrap:anywhere}.zeta-settings .zs-targets{max-height:250px;overflow:auto;display:flex;flex-direction:column;gap:9px}
@media(max-width:600px){.zeta-settings .zs-grid{grid-template-columns:1fr}.zeta-settings .zs-card{padding:12px}.zeta-settings .zs-memes{grid-template-columns:repeat(2,minmax(0,1fr))}.zeta-settings .zs-record-head{flex-wrap:wrap}.zeta-settings .zs-actions>*{max-width:100%}.zeta-settings .zs-head{align-items:flex-start}.zeta-settings .zs-search{align-items:stretch;flex-wrap:wrap}.zeta-settings .zs-search input{min-width:140px}.zeta-settings .zs-tab{padding:8px 10px}.zeta-settings .zs-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;
    document.head.appendChild(style);
  }, []);
}

function Button({ children, onClick, disabled, primary, danger, type = 'button' }: { children?: ReactNode; onClick?: () => void; disabled?: boolean; primary?: boolean; danger?: boolean; type?: 'button' | 'submit' }): ReactNode {
  return h('button', { type, disabled, onClick, className: `zs-button${primary ? ' zs-primary' : ''}${danger ? ' zs-danger' : ''}` }, children);
}
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): ReactNode {
  return h('label', { className: 'zs-field' }, h('span', { className: 'zs-label' }, label), children, hint ? h('span', { className: 'zs-muted' }, hint) : null);
}
function Check({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }): ReactNode {
  return h('label', { className: 'zs-check' }, h('input', { type: 'checkbox', checked, disabled, onChange: (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked) }), h('span', null, label, hint ? h('small', null, hint) : null));
}
function NumberField({ label, hint, value, min, max, step = 1, onChange }: { label: string; hint?: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }): ReactNode {
  return h(Field, { label, hint, children: h('input', { type: 'number', value, min, max, step, required: true, onChange: (event: ChangeEvent<HTMLInputElement>) => onChange(Number(event.target.value)) }) });
}
function Empty({ children }: { children: ReactNode }): ReactNode { return h('div', { className: 'zs-empty' }, children); }

async function readBase64(file: File, maxBytes: number): Promise<string> {
  if (file.size === 0 || file.size > maxBytes) throw new Error(`请选择不超过 ${Math.floor(maxBytes / 1024 / 1024)} MiB 的非空文件。`);
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('无法读取所选文件。'));
    reader.onload = () => {
      if (typeof reader.result !== 'string' || !reader.result.includes(',')) reject(new Error('无法读取所选文件。'));
      else resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

function useMedia(url: string | undefined): { objectUrl?: string; failed: boolean } {
  const [state, setState] = useState<{ objectUrl?: string; failed: boolean }>({ failed: false });
  useEffect(() => {
    const controller = new AbortController(); let objectUrl: string | undefined;
    setState({ failed: false });
    if (url) void (async () => {
      try {
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw await responseError(response);
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob); setState({ objectUrl, failed: false });
      } catch { if (!controller.signal.aborted) setState({ failed: true }); }
    })();
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [url]);
  return state;
}

function MediaImage({ item }: { item: Meme }): ReactNode {
  const media = useMedia(mediaPath('meme', item.id));
  return h('span', { className: 'zs-picture' }, media.objectUrl ? h('img', { src: media.objectUrl, alt: item.caption || '表情图片' }) : h('span', { className: 'zs-muted' }, media.failed ? '预览暂不可用' : '加载图片…'));
}
function AudioPreview({ item }: { item: Speech }): ReactNode {
  const media = useMedia(mediaPath('speech', item.fileName));
  return h('div', { className: 'zs-stack' }, media.objectUrl ? h('audio', { controls: true, preload: 'metadata', src: media.objectUrl, 'aria-label': `${PROVIDER_NAME[item.provider]}语音试听` }) : h('p', { className: 'zs-muted' }, media.failed ? '音频暂时无法读取，请刷新后重试。' : '正在读取音频…'), item.notice ? h('p', { className: 'zs-muted' }, item.notice) : null);
}

async function download(path: string, fileName: string): Promise<void> {
  const response = await fetch(`${API}${path}`, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw await responseError(response);
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName; anchor.style.display = 'none';
  document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Overview({ state, onNavigate }: { state: State; onNavigate: (tab: Tab) => void }): ReactNode {
  const status = state.life.status === 'running' ? '活动中' : state.life.status === 'error' ? '需要查看' : state.settings.life.enabled ? '等待下次活动' : '未开启';
  const stats = [
    ['已知会话', `${knownConversations(state).length} 个`],
    ['公共记忆', `${state.memoryCount} 条`],
    ['语音服务', state.settings.speech.enabled ? PROVIDER_NAME[state.settings.speech.provider] : '未开启'],
    ['自主生活', status],
  ];
  return h('div', { className: 'zs-stack' },
    h('div', { className: 'zs-card zs-stack' }, h('h3', null, state.settings.name), h('p', { className: 'zs-muted' }, 'QQ 连接、人设、记忆、表情与语音集中在这里管理。模型与其他能力沿用 DSH 的配置。'),
      h('div', { className: 'zs-actions' }, h(Button, { onClick: () => onNavigate('persona') }, '编辑人设'), h(Button, { onClick: () => onNavigate('conversations') }, '管理会话'), h(Button, { onClick: () => onNavigate('memory') }, '管理记忆'), h(Button, { onClick: () => onNavigate('life') }, '设置自主生活'))),
    h('div', { className: 'zs-stats' }, stats.map(([label, value]) => h('div', { className: 'zs-card', key: label }, h('p', { className: 'zs-muted' }, label), h('p', { className: 'zs-stat' }, value)))),
    h('div', { className: 'zs-card zs-stack' }, h('h3', null, '最近的生活进展'), h('p', { className: 'zs-body' }, state.life.summary || '还没有活动记录。开启自主生活后，可以在这里查看真实进展。'),
      state.life.focus ? h('p', { className: 'zs-muted' }, `当前关注：${state.life.focus}`) : null,
      h('p', { className: 'zs-muted' }, `最近活动：${date(state.life.lastRunAt)}`), state.life.error ? h('p', { className: 'zs-danger' }, state.life.error) : null),
  );
}

function SettingsFooter({ busy, dirty }: { busy: boolean; dirty: boolean }): ReactNode {
  return h('div', { className: 'zs-actions' }, h('span', { className: 'zs-muted zs-spacer' }, dirty ? '有未保存的修改' : '当前设置已保存'), h(Button, { type: 'submit', primary: true, disabled: busy || !dirty }, busy ? '正在保存…' : '保存设置'));
}

interface SettingsEditorProps { draft: Settings; setDraft: (value: Settings) => void; save: (event: FormEvent<HTMLFormElement>) => void; saving: boolean; dirty: boolean }
function PersonaPanel({ draft, setDraft, save, saving, dirty, feedback, identity, identityBusy, identityOutdated, refreshIdentity, resetIdentity }: SettingsEditorProps & { feedback: Feedback; identity: IdentitySummary; identityBusy: boolean; identityOutdated: boolean; refreshIdentity: () => void; resetIdentity: () => void }): ReactNode {
  const [habitText, setHabitText] = useState((draft.habits ?? []).join('\n'));
  const habits = targetLines(habitText); const invalidHabits = habits.length > 30 || habits.some(value => value.length > 300);
  useEffect(() => { if (JSON.stringify(targetLines(habitText)) !== JSON.stringify(draft.habits ?? [])) setHabitText((draft.habits ?? []).join('\n')); }, [draft.habits, habitText]);
  const history = [...identity.history].sort((a, b) => b.revision - a.revision).slice(0, 8);
  return h('div', { className: 'zs-stack' },
    h('div', { className: 'zs-card zs-stack' }, h('div', { className: 'zs-row' }, h('h3', { className: 'zs-spacer' }, '会逐渐变化的自己'), h('span', { className: 'zs-badge' }, `第 ${identity.revision} 次调整`)),
      h('p', { className: 'zs-muted' }, 'AI 可以根据真实互动和自己的想法调整名字、人设与日常习惯。这些调整不改变管理员、密钥、插件或其他敏感配置的权限。'),
      h('p', { className: 'zs-muted' }, '内置默认人设以社区二创形象为起点，名字、性格与习惯都可以演变；外貌优先参考已上传的人设图。你手写的人设会保留，恢复默认需要点击下方按钮。'),
      identityOutdated ? h('p', { className: 'zs-muted' }, 'AI 已更新自己的身份。请刷新当前身份后再保存，其他功能的草稿会保留。') : null,
      h('p', { className: 'zs-muted' }, '刷新当前身份会载入最新名字、人设和习惯，替换这三项的未保存内容；其他功能的草稿会保留。'),
      h('div', { className: 'zs-actions' }, h(Button, { disabled: saving || identityBusy, onClick: refreshIdentity }, identityBusy ? '正在更新身份…' : '刷新当前身份'),
        h(Button, { danger: true, disabled: saving || identityBusy, onClick: resetIdentity }, '恢复最新默认人设'))),
    h('form', { className: 'zs-stack', onSubmit: (event: FormEvent<HTMLFormElement>) => { if (invalidHabits) { event.preventDefault(); feedback('习惯最多30条，每条最多300字。', true); return; } save(event); } }, h('fieldset', { disabled: saving || identityBusy, className: 'zs-stack' },
    h(Field, { label: '名字', children: h('input', { value: draft.name, maxLength: 80, required: true, onChange: (event: ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, name: event.target.value }) }) }),
    h(Field, { label: '人设与表达习惯', hint: '写下性格、说话方式和重要背景。需要长期记住的经历、偏好与约定可放在所有对话共用的公共记忆里。', children: h('textarea', { value: draft.persona, rows: 12, maxLength: 16000, required: true, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setDraft({ ...draft, persona: event.target.value }) }) }),
    h(Field, { label: '日常习惯', hint: '每行一条，最多30条，每条最多300字。例如：聊天时先听完连续几条消息，再决定是否回应。', children: h('textarea', { value: habitText, rows: 5, maxLength: 9300, 'aria-invalid': invalidHabits, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { const value = event.target.value; setHabitText(value); setDraft({ ...draft, habits: targetLines(value) }); } }) }),
    h('p', { className: invalidHabits ? 'zs-danger' : 'zs-muted zs-small' }, invalidHabits ? '习惯最多30条，每条最多300字，请缩短后保存。' : `已填写 ${habits.length} / 30 条习惯`),
    h(SettingsFooter, { busy: saving || identityBusy, dirty: dirty && !invalidHabits }),
  )),
    h('div', { className: 'zs-card zs-stack' }, h('h3', null, '最近的自我调整'),
      identity.updatedAt ? h('p', { className: 'zs-muted' }, `最近更新：${date(identity.updatedAt)}`) : null,
      history.length ? history.map(item => h('article', { key: item.revision, className: 'zs-record zs-stack' },
        h('div', { className: 'zs-record-head' }, h('span', { className: 'zs-record-title' }, item.reason || '调整自己的表达'), h('span', { className: 'zs-muted zs-small' }, date(item.createdAt))),
        h('p', { className: 'zs-muted' }, [item.before.name !== item.after.name ? `名字：${item.before.name} → ${item.after.name}` : '', item.before.persona !== item.after.persona ? '人设已调整' : '', JSON.stringify(item.before.habits) !== JSON.stringify(item.after.habits) ? `习惯更新为 ${item.after.habits.length} 条` : ''].filter(Boolean).join(' · ') || '已保留当前身份'),
        h('details', null, h('summary', null, '查看调整后的内容'), h('p', { className: 'zs-body' }, `名字：${item.after.name}\n\n${item.after.persona}`), item.after.habits.length ? h('ul', null, item.after.habits.map((habit, index) => h('li', { key: index }, habit))) : null))) : h('p', { className: 'zs-muted' }, '还没有自我调整记录。AI 做出调整后会在这里留下原因。')),
    h(PersonaImagePanel, { feedback }));
}

function PersonaImagePanel({ feedback }: { feedback: Feedback }): ReactNode {
  const [reference, setReference] = useState<PersonaReference>(); const [description, setDescription] = useState(''); const [file, setFile] = useState<File>();
  const input = useRef<HTMLInputElement>(null); const task = useTask(feedback);
  const load = useCallback(async (signal?: AbortSignal): Promise<void> => { const value = await request<{ reference?: PersonaReference }>('/persona', 'GET', undefined, signal); if (!signal?.aborted) { setReference(value.reference); setDescription(value.reference?.description || ''); } }, []);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal).catch(error => { if (!controller.signal.aborted) feedback(message(error), true); }); return () => controller.abort(); }, [load, feedback]);
  const media = useMedia(reference ? `${API}/persona/image?id=${encodeURIComponent(reference.id)}` : undefined);
  return h('div', { className: 'zs-card zs-stack' }, h('h3', null, '自己的形象'),
    h('p', { className: 'zs-muted' }, '所有对话共用这张人设图。AI 创作自画像或自拍时会自动带上原图作为参考；外貌描述会加入对话上下文。'),
    media.objectUrl ? h('div', { className: 'zs-preview' }, h('img', { src: media.objectUrl, alt: reference?.description || '当前人设图', style: { maxWidth: '100%', maxHeight: 300, objectFit: 'contain' } })) : reference ? h('p', { className: 'zs-muted' }, media.failed ? '预览暂不可用' : '正在读取人设图…') : null,
    h(Field, { label: reference ? '更换人设图' : '上传人设图', hint: 'PNG、JPEG、WebP，最大 8 MiB。更换会替代当前主图。', children: h('input', { ref: input, type: 'file', accept: '.png,.jpg,.jpeg,.webp', disabled: task.busy, onChange: (event: ChangeEvent<HTMLInputElement>) => setFile(event.target.files?.[0]) }) }),
    h(Button, { disabled: task.busy || !file, onClick: () => { void task.run(async () => { if (!file) return; const value = await request<{ reference: PersonaReference; notice?: string }>('/persona', 'POST', { fileName: file.name, base64: await readBase64(file, 8 * 1024 * 1024) }); setReference(value.reference); setDescription(value.reference.description || ''); setFile(undefined); if (input.current) input.current.value = ''; feedback(value.notice || '人设图已保存，自画像会自动引用。'); }); } }, task.busy ? '处理中…' : '保存人设图'),
    reference ? h('div', { className: 'zs-stack' }, h(Field, { label: '外貌描述', hint: '可手动填写发型、服装、配色等；已配置视觉模型时也可以从原图生成。', children: h('textarea', { value: description, rows: 5, maxLength: 4000, disabled: task.busy, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setDescription(event.target.value) }) }),
      h('div', { className: 'zs-actions' },
        h(Button, { disabled: task.busy || description === reference.description, onClick: () => { void task.run(async () => { await request('/persona', 'PATCH', { description }); await load(); feedback('外貌描述已保存。'); }); } }, '保存外貌描述'),
        h(Button, { disabled: task.busy, onClick: () => { void task.run(async () => { await request('/persona/describe', 'POST', {}); await load(); feedback('已根据人设图更新外貌描述。'); }); } }, '从图片生成描述'),
        h(Button, { danger: true, disabled: task.busy, onClick: () => { void task.run(async () => { await request('/persona', 'DELETE', {}); await load(); feedback('人设图已移除。'); }); } }, '移除人设图'))) : null);
}

function ConversationRow({ item, feedback, refreshState }: { item: Conversation; feedback: Feedback; refreshState: () => Promise<void> }): ReactNode {
  const [alias, setAlias] = useState(item.alias || '');
  const task = useTask(feedback);
  useEffect(() => setAlias(item.alias || ''), [item.alias]);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void task.run(async () => {
      await request('/conversations', 'PATCH', { target: item.target, title: alias.trim() });
      await refreshState();
      feedback(alias.trim() ? '会话别名已保存，可直接用这个名字向机器人指定目标。' : '已恢复会话的默认名称。');
    });
  };
  return h('article', { className: 'zs-record' },
    h('div', { className: 'zs-record-head' }, h('div', { className: 'zs-record-title' }, conversationName(item)), h('span', { className: 'zs-badge' }, item.active ? '目标可用' : '目标当前不可用')),
    h('p', { className: 'zs-muted' }, `${item.scope === 'group' ? '群聊' : '私聊'} · ${item.sessionId ? '已有会话记录' : '尚无会话记录'} · 最近收到消息：${date(item.lastSeenAt)}`),
    h('form', { onSubmit: submit, className: 'zs-stack', style: { marginTop: 10 } }, h('fieldset', { disabled: task.busy, className: 'zs-stack' },
      h(Field, { label: '会话别名', hint: '例如“朋友群”。留空保存可恢复默认名称。', children: h('input', { value: alias, maxLength: 80, placeholder: item.title || '给这个聊天起个容易识别的名字', onChange: (event: ChangeEvent<HTMLInputElement>) => setAlias(event.target.value) }) }),
      h('div', { className: 'zs-actions' }, h(Button, { type: 'submit', disabled: task.busy || alias.trim() === (item.alias || '') }, task.busy ? '保存中…' : '保存别名'),
        h('details', null, h('summary', { className: 'zs-muted' }, '查看目标标识'), h('p', { className: 'zs-code' }, item.target))))),
  );
}

function ConversationsPanel({ state, feedback, refreshState, draft, setDraft, save, saving, dirty }: SettingsEditorProps & { state: State; feedback: Feedback; refreshState: () => Promise<void> }): ReactNode {
  const choices = useMemo(() => knownConversations(state), [state.bindings, state.conversations]);
  const config = draft.conversations ?? { allowCrossSend: true, allowCrossRead: true };
  return h('div', { className: 'zs-stack' },
    h('form', { className: 'zs-card zs-stack', onSubmit: save }, h('h3', null, '普通聊天的跨会话操作'),
      h('p', { className: 'zs-muted' }, '以下开关适用于所有能与机器人聊天的人。开启后，可以在一个聊天中请机器人去另一个已知聊天发消息，或查看那里的近期对话。'),
      h('fieldset', { disabled: saving, className: 'zs-stack' },
        h(Check, { label: '允许跨会话发送', hint: '发送时必须明确指定已知目标；默认回复仍发在当前聊天。', checked: config.allowCrossSend, onChange: allowCrossSend => setDraft({ ...draft, conversations: { ...config, allowCrossSend } }) }),
        h(Check, { label: '允许读取其他会话的近期对话', hint: '只有明确调用读取工具时才提供内容；此页面仅显示会话名称和状态。', checked: config.allowCrossRead, onChange: allowCrossRead => setDraft({ ...draft, conversations: { ...config, allowCrossRead } }) }),
        h('p', { className: 'zs-muted' }, '自主生活使用单独的读取和发送名单，在“自主生活”中设置。'), h(SettingsFooter, { busy: saving, dirty }))),
    h('div', { className: 'zs-card zs-stack' }, h('div', { className: 'zs-row' }, h('h3', { className: 'zs-spacer' }, '机器人已知的聊天'), h(Button, { onClick: () => { void refreshState().then(() => feedback('会话目录已刷新。')).catch(error => feedback(message(error), true)); } }, '刷新目录')),
      choices.length ? h('div', null, choices.map(item => h(ConversationRow, { key: item.target, item, feedback, refreshState }))) : h(Empty, null, '还没有发现 QQ 会话。请先与机器人聊天，或在群里 @ 它一次。'),
      !choices.some(item => item.scope === 'group') ? h('p', { className: 'zs-muted' }, '还没发现群聊？在目标群里 @ 机器人一次，再刷新会话目录。') : null,
      h('p', { className: 'zs-muted' }, '群目标使用 QQ 接口提供的 group_openid，群号不能替代 group_openid。机器人只能发现实际收到过事件的聊天。')),
  );
}

function MemoryPanel({ feedback, draft, setDraft, save, saving, dirty }: SettingsEditorProps & { feedback: Feedback }): ReactNode {
  const [items, setItems] = useState<Memory[]>([]); const [loading, setLoading] = useState(false); const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Memory>(); const [key, setKey] = useState(''); const [value, setValue] = useState(''); const [tags, setTags] = useState(''); const [pinned, setPinned] = useState(false);
  const task = useTask(feedback);
  const load = useCallback(async (signal?: AbortSignal): Promise<void> => { const result = await request<{ items: Memory[] }>('/memory', 'GET', undefined, signal); if (!signal?.aborted) setItems(result.items); }, []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setItems([]); setEditing(undefined); setKey(''); setValue(''); setTags(''); setPinned(false);
    void load(controller.signal).catch(error => { if (!controller.signal.aborted) feedback(message(error), true); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [load, feedback]);
  const visible = items.filter(item => `${item.key} ${item.value} ${item.tags.join(' ')}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const clear = (): void => { setEditing(undefined); setKey(''); setValue(''); setTags(''); setPinned(false); };
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault(); void task.run(async () => {
      await request('/memory', 'POST', { key: key.trim(), value: value.trim(), tags: splitTags(tags), pinned, ...(editing ? { expectedUpdatedAt: editing.updatedAt } : {}) });
      clear(); await load(); feedback(editing ? '记忆已更新。' : '记忆已保存。');
    });
  };
  return h('div', { className: 'zs-stack' },
    h('div', { className: 'zs-card zs-stack' }, h('div', { className: 'zs-row' }, h('h3', { className: 'zs-spacer' }, '公共记忆'), h(Button, { disabled: loading || task.busy, onClick: () => { void task.run(async () => { await load(); feedback('记忆已刷新。'); }); } }, '刷新')),
      h('input', { type: 'search', value: query, placeholder: '搜索内容、名称或标签', 'aria-label': '搜索长期记忆', onChange: (event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value) }),
      loading ? h(Empty, null, '正在读取记忆…') : visible.length === 0 ? h(Empty, null, items.length ? '没有找到匹配的记忆。' : '这里还没有记忆。可以添加一条偏好或约定。') : h('div', null, visible.map(item => h('article', { className: 'zs-record', key: item.key },
        h('div', { className: 'zs-record-head' }, h('div', { className: 'zs-record-title' }, item.key, item.pinned ? h('span', { className: 'zs-badge' }, ' 常用') : null), h('div', { className: 'zs-actions' },
          h(Button, { disabled: task.busy, onClick: () => { setEditing(item); setKey(item.key); setValue(item.value); setTags(item.tags.join('，')); setPinned(item.pinned); } }, '编辑'),
          h(Button, { danger: true, disabled: task.busy, onClick: () => { void task.run(async () => { await request('/memory', 'DELETE', { key: item.key }); if (editing?.key === item.key) clear(); await load(); feedback('这条长期记忆已删除。'); }); } }, '删除'))),
        h('p', { className: 'zs-body' }, item.value), h('p', { className: 'zs-muted' }, `${item.tags.length ? `${item.tags.join(' · ')}　` : ''}${date(item.updatedAt)}`))))),
    h('form', { className: 'zs-card zs-stack', onSubmit: submit }, h('h3', null, editing ? '编辑记忆' : '添加记忆'), h('fieldset', { disabled: task.busy, className: 'zs-stack' },
      h(Field, { label: '名称', hint: '同一名称保存时会更新原有内容。', children: h('input', { value: key, disabled: !!editing, required: true, maxLength: 120, placeholder: '例如：喜欢的饮料', onChange: (event: ChangeEvent<HTMLInputElement>) => setKey(event.target.value) }) }),
      h(Field, { label: '内容', children: h('textarea', { value, required: true, maxLength: draft.memory.maxValueChars, rows: 4, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setValue(event.target.value) }) }),
      h(Field, { label: '标签', hint: '用逗号或空格分开，可留空。', children: h('input', { value: tags, maxLength: 700, placeholder: '偏好，约定', onChange: (event: ChangeEvent<HTMLInputElement>) => setTags(event.target.value) }) }),
      h(Check, { label: '作为常用记忆', hint: '在有限的记忆提示中优先使用。', checked: pinned, onChange: setPinned }),
      h('div', { className: 'zs-actions' }, h(Button, { type: 'submit', primary: true, disabled: task.busy }, task.busy ? '保存中…' : editing ? '保存修改' : '添加记忆'), editing ? h(Button, { onClick: clear }, '取消编辑') : null))),
    h('form', { className: 'zs-card', onSubmit: save }, h('details', null, h('summary', null, '记忆设置'), h('fieldset', { disabled: saving, className: 'zs-stack' },
      h(Check, { label: '启用长期记忆', checked: draft.memory.enabled, onChange: enabled => setDraft({ ...draft, memory: { ...draft.memory, enabled } }) }),
      h('div', { className: 'zs-grid' },
        h(NumberField, { label: '公共记忆最多保存条数', value: draft.memory.maxItems, min: 10, max: 1000, onChange: maxItems => setDraft({ ...draft, memory: { ...draft.memory, maxItems } }) }),
        h(NumberField, { label: '单条记忆字数上限', value: draft.memory.maxValueChars, min: 100, max: 4000, onChange: maxValueChars => setDraft({ ...draft, memory: { ...draft.memory, maxValueChars } }) }),
        h(NumberField, { label: '自动带入条数', value: draft.memory.injectItems, min: 0, max: 12, onChange: injectItems => setDraft({ ...draft, memory: { ...draft.memory, injectItems } }) }),
        h(NumberField, { label: '自动带入总字数', value: draft.memory.injectChars, min: 0, max: 6000, onChange: injectChars => setDraft({ ...draft, memory: { ...draft.memory, injectChars } }) })), h(SettingsFooter, { busy: saving, dirty })))),
    h('p', { className: 'zs-muted' }, '公共记忆由所有私聊、群聊与自主生活共用。这里删除的是记忆条目，DSH 原始聊天历史另行管理。'),
  );
}

function MemePanel({ feedback }: { feedback: Feedback }): ReactNode {
  const [items, setItems] = useState<Meme[]>([]); const [total, setTotal] = useState(0); const [more, setMore] = useState(false); const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState(''); const [search, setSearch] = useState(''); const [offset, setOffset] = useState(0); const [selected, setSelected] = useState<Meme>();
  const [caption, setCaption] = useState(''); const [tag, setTag] = useState(''); const [words, setWords] = useState(''); const [upload, setUpload] = useState<File>();
  const [uploadCaption, setUploadCaption] = useState(''); const [uploadTag, setUploadTag] = useState(''); const [uploadWords, setUploadWords] = useState('');
  const importInput = useRef<HTMLInputElement>(null); const uploadInput = useRef<HTMLInputElement>(null); const task = useTask(feedback); const limit = 24;
  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const result = await request<{ items: Meme[]; total: number; hasMore: boolean }>(`/memes?${new URLSearchParams({ query: search, offset: String(offset), limit: String(limit) })}`, 'GET', undefined, signal);
    if (!signal?.aborted) { setItems(result.items); setTotal(result.total); setMore(result.hasMore); }
  }, [search, offset]);
  useEffect(() => { const controller = new AbortController(); setLoading(true); setSelected(undefined); void load(controller.signal).catch(error => { if (!controller.signal.aborted) feedback(message(error), true); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }); return () => controller.abort(); }, [load, feedback]);
  const edit = (item: Meme): void => { setSelected(item); setCaption(item.caption); setTag(item.tag ?? ''); setWords(keywords(item.keywords)); };
  const save = (event: FormEvent<HTMLFormElement>): void => { event.preventDefault(); if (!selected) return; void task.run(async () => { await request('/memes', 'PATCH', { id: selected.id, caption: caption.trim(), tag: tag.trim(), keywords: splitTags(words) }); setSelected(undefined); await load(); feedback('表情说明已保存。'); }); };
  const add = (event: FormEvent<HTMLFormElement>): void => { event.preventDefault(); void task.run(async () => { if (!upload) throw new Error('请先选择一张图片。'); const base64 = await readBase64(upload, 8 * 1024 * 1024); await request('/memes', 'POST', { fileName: upload.name, base64, caption: uploadCaption.trim(), tag: uploadTag.trim(), keywords: splitTags(uploadWords) }); setUpload(undefined); setUploadCaption(''); setUploadTag(''); setUploadWords(''); if (uploadInput.current) uploadInput.current.value = ''; await load(); feedback('表情已加入共享收藏。'); }); };
  const importZip = (file: File): void => { void task.run(async () => {
    const base64 = await readBase64(file, 80 * 1024 * 1024);
    const result = await request<MemeImport>('/memes/import', 'POST', { base64 });
    let refreshWarning = '';
    try { await load(); } catch { refreshWarning = ' 收藏列表刷新失败，请手动刷新。'; }
    const incomplete = result.complete !== true || !!result.error || result.cancelled === true;
    const reason = result.error ? ` ${result.error.slice(0, 2000)}` : result.cancelled ? ' 导入已取消。' : incomplete ? ' 其余图片尚未导入，请检查后再操作。' : '';
    feedback(`图库导入${incomplete ? '未完成' : '完成'}：已导入 ${result.imported} 张，跳过 ${result.skipped} 项。${reason}${refreshWarning}`, incomplete || !!refreshWarning);
  }); };
  return h('div', { className: 'zs-stack' },
    h('div', { className: 'zs-card zs-stack' }, h('div', { className: 'zs-row' }, h('h3', { className: 'zs-spacer' }, `表情图库 · ${total} 张`), h(Button, { disabled: loading || task.busy, onClick: () => { void task.run(async () => { await load(); feedback('图库已刷新。'); }); } }, '刷新')),
      h('form', { className: 'zs-search', onSubmit: (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setOffset(0); setSearch(query.trim()); } }, h('input', { type: 'search', value: query, maxLength: 200, placeholder: '搜索表情、情绪或关键词', 'aria-label': '搜索表情', onChange: (event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value) }), h(Button, { type: 'submit', disabled: loading }, '搜索')),
      loading ? h(Empty, null, '正在读取图库…') : items.length ? h('div', { className: 'zs-memes' }, items.map(item => h('button', { key: item.id, type: 'button', className: 'zs-meme', 'aria-pressed': selected?.id === item.id, onClick: () => edit(item) }, h(MediaImage, { item }), h('span', { className: 'zs-caption' }, item.caption || item.fileName || '未命名表情'), h('span', { className: 'zs-muted zs-small' }, item.builtin ? '内置图库' : item.tag || '我的收藏')))) : h(Empty, null, '没有匹配的表情，可以上传一张自己的图片。'),
      h('div', { className: 'zs-actions' }, h(Button, { disabled: loading || offset === 0, onClick: () => setOffset(Math.max(0, offset - limit)) }, '上一页'), h('span', { className: 'zs-muted zs-spacer' }, total ? `${offset + 1}–${Math.min(offset + items.length, total)} / ${total}` : '0 张'), h(Button, { disabled: loading || !more, onClick: () => setOffset(offset + limit) }, '下一页'))),
    selected ? h('form', { className: 'zs-card zs-stack', onSubmit: save }, h('div', { className: 'zs-row' }, h('h3', { className: 'zs-spacer' }, selected.builtin ? '内置表情' : '编辑表情'), h(Button, { onClick: () => setSelected(undefined) }, '收起')), h('div', { className: 'zs-preview' }, h(MediaImage, { item: selected })),
      selected.builtin ? h('div', { className: 'zs-stack' }, h('p', { className: 'zs-body' }, selected.caption), h('p', { className: 'zs-muted' }, `分类：${selected.tag || '未分类'}${keywords(selected.keywords) ? `　关键词：${keywords(selected.keywords)}` : ''}`), h('p', { className: 'zs-muted' }, '内置表情和收藏供所有私聊、群聊及自主生活共用。')) : h('fieldset', { disabled: task.busy, className: 'zs-stack' },
        h(Field, { label: '表情说明', children: h('textarea', { value: caption, required: true, maxLength: 500, rows: 3, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setCaption(event.target.value) }) }),
        h('div', { className: 'zs-grid' }, h(Field, { label: '分类', children: h('input', { value: tag, maxLength: 80, onChange: (event: ChangeEvent<HTMLInputElement>) => setTag(event.target.value) }) }), h(Field, { label: '关键词', children: h('input', { value: words, maxLength: 600, onChange: (event: ChangeEvent<HTMLInputElement>) => setWords(event.target.value) }) })),
        h('div', { className: 'zs-actions' }, h(Button, { primary: true, type: 'submit', disabled: task.busy }, '保存说明'), h(Button, { danger: true, disabled: task.busy, onClick: () => { void task.run(async () => { await request('/memes', 'DELETE', { id: selected.id }); setSelected(undefined); await load(); feedback('表情已从共享收藏删除。'); }); } }, '删除表情')))) : null,
    h('form', { className: 'zs-card zs-stack', onSubmit: add }, h('h3', null, '收藏新表情'), h('fieldset', { disabled: task.busy, className: 'zs-stack' },
      h(Field, { label: '图片', hint: '支持 PNG、JPG、WebP、GIF，最大 8 MiB。GIF 通过这里上传可保留原文件。', children: h('input', { ref: uploadInput, type: 'file', accept: '.png,.jpg,.jpeg,.webp,.gif', onChange: (event: ChangeEvent<HTMLInputElement>) => setUpload(event.target.files?.[0]) }) }),
      h(Field, { label: '表情说明', children: h('input', { value: uploadCaption, required: true, maxLength: 500, placeholder: '例如：开心地挥手打招呼', onChange: (event: ChangeEvent<HTMLInputElement>) => setUploadCaption(event.target.value) }) }),
      h('div', { className: 'zs-grid' }, h(Field, { label: '分类', children: h('input', { value: uploadTag, maxLength: 80, placeholder: '例如：开心', onChange: (event: ChangeEvent<HTMLInputElement>) => setUploadTag(event.target.value) }) }), h(Field, { label: '关键词', children: h('input', { value: uploadWords, maxLength: 600, placeholder: '你好，挥手，开心', onChange: (event: ChangeEvent<HTMLInputElement>) => setUploadWords(event.target.value) }) })), h('div', null, h(Button, { type: 'submit', primary: true, disabled: task.busy || !upload }, task.busy ? '处理中…' : '加入收藏')))),
    h('div', { className: 'zs-card zs-stack' }, h('h3', null, '图库导入与导出'), h('p', { className: 'zs-muted' }, '以 ZIP 保存或导入当前收藏。压缩包最大 80 MiB，解压内容合计最大 64 MiB。内置图库不受影响。'), h('input', { ref: importInput, type: 'file', accept: '.zip', style: { display: 'none' }, 'aria-label': '选择图库ZIP', onChange: (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) importZip(file); } }),
      h('div', { className: 'zs-actions' }, h(Button, { disabled: task.busy, onClick: () => importInput.current?.click() }, '导入 ZIP'), h(Button, { disabled: task.busy, onClick: () => { void task.run(async () => { await download('/memes/export', `${PLUGIN_NAME}-表情收藏.zip`); feedback('图库下载已开始。'); }); } }, '导出当前收藏'))),
  );
}

function CredentialCard({ provider, configured, feedback, onSaved }: { provider: Provider; configured: boolean; feedback: Feedback; onSaved: () => Promise<void> }): ReactNode {
  const [value, setValue] = useState(''); const task = useTask(feedback); const id = useId();
  return h('form', { className: 'zs-card zs-stack', onSubmit: (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void task.run(async () => { if (!value.trim()) throw new Error('请填写密钥。'); await request('/credential', 'PUT', { provider, value: value.trim() }); setValue(''); await onSaved(); feedback(`${PROVIDER_NAME[provider]} 密钥已保存。`); }); } },
    h('div', { className: 'zs-row' }, h('h3', { className: 'zs-spacer' }, `${PROVIDER_NAME[provider]} 密钥`), h('span', { className: 'zs-badge' }, configured ? '已配置' : '未配置')),
    h('label', { className: 'zs-field', htmlFor: id }, h('span', { className: 'zs-muted' }, configured ? '需要更换时填写新密钥，现有密钥不会显示。' : '密钥只提交给本机 DSH，不保存在浏览器草稿中。'), h('input', { id, type: 'password', autoComplete: 'new-password', spellCheck: false, value, maxLength: 8192, disabled: task.busy, placeholder: configured ? '输入新密钥以更换' : '输入服务 API 密钥', onChange: (event: ChangeEvent<HTMLInputElement>) => setValue(event.target.value) })),
    h('div', { className: 'zs-actions' }, h(Button, { type: 'submit', primary: true, disabled: task.busy || !value.trim() }, task.busy ? '保存中…' : '保存密钥'), configured ? h(Button, { danger: true, disabled: task.busy, onClick: () => { void task.run(async () => { await request('/credential', 'PUT', { provider, value: null }); setValue(''); await onSaved(); feedback(`${PROVIDER_NAME[provider]} 密钥已清除。`); }); } }, '清除密钥') : null));
}

function ProviderEditor({ provider, value, onChange }: { provider: Provider; value: ProviderSettings; onChange: (next: ProviderSettings) => void }): ReactNode {
  const voicesId = useId(); const mimo = provider === 'mimo';
  const models = mimo ? ['mimo-v2.5-tts'] : ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo'];
  const voices = mimo ? ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'] : ['male-qn-qingse', 'female-shaonv', 'female-yujie', 'Chinese (Mandarin)_Warm_Bestie', 'Chinese (Mandarin)_Warm_Girl'];
  const emotions = value.model.startsWith('speech-2.6-') ? [...EMOTIONS, { value: 'fluent', label: '流畅' }, { value: 'whisper', label: '低语' }] : EMOTIONS;
  return h('div', { className: 'zs-card zs-stack' }, h('h3', null, `${PROVIDER_NAME[provider]} 声音设置`),
    h(Field, { label: '模型', children: h('select', { value: value.model, onChange: (event: ChangeEvent<HTMLSelectElement>) => onChange({ ...value, model: event.target.value, ...(mimo ? {} : { emotion: 'auto' }) }) }, !models.includes(value.model) ? h('option', { value: value.model }, value.model) : null, models.map(model => h('option', { key: model, value: model }, model))) }),
    h(Field, { label: '声线', hint: mimo ? '可选择预置声线。' : '可选择常用声线，也可填写服务中的声线 ID。', children: h('input', { value: value.voice, list: voicesId, required: true, maxLength: 240, onChange: (event: ChangeEvent<HTMLInputElement>) => onChange({ ...value, voice: event.target.value }) }) }), h('datalist', { id: voicesId }, voices.map(voice => h('option', { key: voice, value: voice }))),
    h(NumberField, { label: '语速', value: value.speed, min: 0.5, max: 2, step: 0.1, hint: mimo ? 'MiMo 的语速调整为近似效果。' : '1 为正常语速。', onChange: speed => onChange({ ...value, speed }) }),
    !mimo ? h(Field, { label: '情绪', children: h('select', { value: value.emotion || 'auto', onChange: (event: ChangeEvent<HTMLSelectElement>) => onChange({ ...value, emotion: event.target.value }) }, emotions.map(emotion => h('option', { key: emotion.value, value: emotion.value }, emotion.label))) }) : null,
  );
}

function SpeechPanel({ feedback, state, refreshState, draft, setDraft, save, saving, dirty }: SettingsEditorProps & { feedback: Feedback; state: State; refreshState: () => Promise<void> }): ReactNode {
  const [text, setText] = useState(''); const [provider, setProvider] = useState<Provider>(state.settings.speech.provider); const [items, setItems] = useState<Speech[]>([]); const [selected, setSelected] = useState<Speech>(); const [loading, setLoading] = useState(false); const task = useTask(feedback);
  const load = useCallback(async (signal?: AbortSignal): Promise<void> => { const result = await request<{ items: Speech[] }>('/speech', 'GET', undefined, signal); if (!signal?.aborted) setItems(result.items); }, []);
  useEffect(() => { const controller = new AbortController(); setSelected(undefined); setItems([]); setLoading(true); void load(controller.signal).catch(error => { if (!controller.signal.aborted) feedback(message(error), true); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }); return () => controller.abort(); }, [load, feedback]);
  const generate = (event: FormEvent<HTMLFormElement>): void => { event.preventDefault(); void task.run(async () => { const result = await request<{ result: Speech }>('/speech', 'POST', { text: text.trim(), provider }); setSelected(result.result); await load(); feedback('语音已生成，可以在下方试听。'); }); };
  const speech = draft.speech;
  return h('div', { className: 'zs-stack' },
    h('div', { className: 'zs-grid' }, (['mimo', 'minimax'] as const).map(service => h(CredentialCard, { key: service, provider: service, configured: state.credentials[service], feedback, onSaved: refreshState }))),
    h('form', { className: 'zs-stack', onSubmit: save }, h('fieldset', { disabled: saving, className: 'zs-stack' },
      h('div', { className: 'zs-card zs-stack' }, h(Check, { label: '启用语音生成', checked: speech.enabled, onChange: enabled => setDraft({ ...draft, speech: { ...speech, enabled } }) }),
        h(Field, { label: '默认语音服务', children: h('select', { value: speech.provider, onChange: (event: ChangeEvent<HTMLSelectElement>) => setDraft({ ...draft, speech: { ...speech, provider: event.target.value as Provider } }) }, h('option', { value: 'mimo' }, 'MiMo'), h('option', { value: 'minimax' }, 'MiniMax')) }),
        h('div', { className: 'zs-grid' }, h(NumberField, { label: '每条语音最多字数', value: speech.maxTextCharacters, min: 1, max: 5000, onChange: maxTextCharacters => setDraft({ ...draft, speech: { ...speech, maxTextCharacters } }) }), h(NumberField, { label: '最长等待时间（秒）', value: speech.timeoutMs / 1000, min: 1, max: 180, onChange: seconds => setDraft({ ...draft, speech: { ...speech, timeoutMs: seconds * 1000 } }) }))),
      h('div', { className: 'zs-grid' }, h(ProviderEditor, { provider: 'mimo', value: speech.mimo, onChange: mimo => setDraft({ ...draft, speech: { ...speech, mimo } }) }), h(ProviderEditor, { provider: 'minimax', value: speech.minimax, onChange: minimax => setDraft({ ...draft, speech: { ...speech, minimax } }) })), h(SettingsFooter, { busy: saving, dirty }))),
    h('form', { className: 'zs-card zs-stack', onSubmit: generate }, h('h3', null, '生成与试听'), h('p', { className: 'zs-muted' }, '试听使用已保存的声音设置，可能产生所选服务的费用。这里只生成音频，不向 QQ 发送。'),
      h('fieldset', { disabled: task.busy, className: 'zs-stack' }, h(Field, { label: '试听服务', children: h('select', { value: provider, onChange: (event: ChangeEvent<HTMLSelectElement>) => setProvider(event.target.value as Provider) }, h('option', { value: 'mimo' }, 'MiMo'), h('option', { value: 'minimax' }, 'MiniMax')) }),
        h(Field, { label: '朗读内容', children: h('textarea', { value: text, required: true, rows: 4, maxLength: state.settings.speech.maxTextCharacters, placeholder: '写一段想听的话…', onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value) }) }),
        !state.settings.speech.enabled ? h('p', { className: 'zs-muted' }, '请先启用语音生成并保存设置。') : !state.credentials[provider] ? h('p', { className: 'zs-muted' }, `请先保存 ${PROVIDER_NAME[provider]} 的密钥。`) : null,
        h('div', { className: 'zs-actions' }, h(Button, { type: 'submit', primary: true, disabled: task.busy || !text.trim() || !state.settings.speech.enabled || !state.credentials[provider] }, task.busy ? '正在生成，请稍候…' : '生成试听'), h('span', { className: 'zs-muted' }, `${Array.from(text).length} / ${state.settings.speech.maxTextCharacters} 字`))),
      selected ? h('div', { className: 'zs-stack' }, h('p', { className: 'zs-muted' }, `${PROVIDER_NAME[selected.provider]} · ${selected.voice} · ${date(selected.createdAt)}`), h(AudioPreview, { item: selected })) : null),
    h('div', { className: 'zs-card zs-stack' }, h('div', { className: 'zs-row' }, h('h3', { className: 'zs-spacer' }, '所有对话的语音记录'), h(Button, { disabled: loading || task.busy, onClick: () => { void task.run(async () => { await load(); feedback('语音记录已刷新。'); }); } }, '刷新')),
      loading ? h(Empty, null, '正在读取语音记录…') : items.length ? h('div', null, items.map(item => h('div', { className: 'zs-record', key: item.fileName }, h('div', { className: 'zs-record-head' }, h('div', null, h('p', { className: 'zs-record-title' }, `${PROVIDER_NAME[item.provider]} · ${item.voice}`), h('p', { className: 'zs-muted' }, `${date(item.createdAt)} · ${item.characters} 字 · ${Math.max(1, Math.round(item.bytes / 1024))} KB`)), h(Button, { onClick: () => setSelected(item) }, '试听'))))) : h(Empty, null, '还没有生成语音。')),
  );
}

function LifePanel({ state, feedback, refreshState, draft, setDraft, save, saving, dirty }: SettingsEditorProps & { state: State; feedback: Feedback; refreshState: () => Promise<void> }): ReactNode {
  const life = draft.life; const task = useTask(feedback);
  const choices = useMemo(() => knownConversations(state).map(item => [item.target, item] as const), [state.bindings, state.conversations]);
  const readTargets = life.readTargets ?? [];
  const known = new Set(choices.map(([target]) => target));
  const [extraTargets, setExtraTargets] = useState(() => life.targets.filter(target => !known.has(target)).join('\n'));
  useEffect(() => {
    const selected = life.targets.filter(target => !known.has(target)).join('\n');
    const typed = targetLines(extraTargets).filter(target => !known.has(target)).join('\n');
    if (selected !== typed) setExtraTargets(selected);
  }, [life.targets, choices, extraTargets]);
  const update = (patch: Partial<Settings['life']>): void => setDraft({ ...draft, life: { ...life, ...patch } });
  const manual = (path: '/life/run' | '/life/stop'): void => { void task.run(async () => { await request(path, 'POST', {}); await refreshState(); feedback(path === '/life/run' ? '活动请求已提交，可稍后刷新查看进展。' : '已提交停止请求。'); }); };
  const extras = targetLines(extraTargets); const invalidTargets = extras.some(target => !/^(c2c|group):[^\s:]+$/u.test(target));
  return h('div', { className: 'zs-stack' },
    h('div', { className: 'zs-card zs-stack' }, h('div', { className: 'zs-row' }, h('h3', { className: 'zs-spacer' }, '当前活动'), h('span', { className: 'zs-badge' }, state.life.status === 'running' ? '活动中' : state.life.status === 'error' ? '需要查看' : state.settings.life.enabled ? '等待下次活动' : '未开启')),
      h('p', { className: 'zs-body' }, state.life.summary || '尚无活动进展。'), h('p', { className: 'zs-muted' }, state.life.nextWakeAt ? `下次活动：${date(state.life.nextWakeAt)} · ${state.life.nextWakeReason || 'AI 已安排'}` : `下次活动：${state.life.nextWakeReason || '暂未安排，等待新事件或手动运行'}`), state.life.focus ? h('p', { className: 'zs-muted' }, `当前关注：${state.life.focus}`) : null, h('p', { className: 'zs-muted' }, `开始：${date(state.life.lastRunAt)}　结束：${date(state.life.lastFinishedAt)}`), state.life.error ? h('p', { className: 'zs-danger' }, state.life.error) : null,
      h('div', { className: 'zs-actions' }, h(Button, { disabled: task.busy || !state.settings.life.enabled || state.life.status === 'running', onClick: () => manual('/life/run') }, task.busy ? '处理中…' : '现在活动一次'), h(Button, { disabled: task.busy, onClick: () => manual('/life/stop') }, '停止当前活动'), h(Button, { disabled: task.busy, onClick: () => { void task.run(refreshState); } }, '刷新进展'))),
    h('form', { className: 'zs-stack', onSubmit: (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (invalidTargets) feedback('请检查手动填写的联系目标格式。', true); else save(event); } }, h('fieldset', { disabled: saving, className: 'zs-stack' },
      h('div', { className: 'zs-card zs-stack' }, h(Check, { label: '开启自主生活', hint: '由 DSH 自动任务唤醒，可以探索、创作、整理，也可以选择休息。活动可能使用模型与已启用工具。', checked: life.enabled, onChange: enabled => update({ enabled }) }),
        h(NumberField, { label: '每日自主活动上限', hint: '达到上限后休息；不影响正常 QQ 对话。', value: life.maxDailyRuns, min: 1, max: 1000, onChange: maxDailyRuns => update({ maxDailyRuns }) }),
        h(Field, { label: '兴趣与活动方向', children: h('textarea', { value: life.interests, rows: 5, maxLength: 4000, placeholder: '希望关注的话题、想继续的小创作…', onChange: (event: ChangeEvent<HTMLTextAreaElement>) => update({ interests: event.target.value }) }) }),
        h('div', { className: 'zs-grid' }, h(NumberField, { label: '最短活动间隔（分钟）', hint: '仅作为使用下限，实际下次时间由 AI 决定。', value: life.minIntervalMinutes, min: 1, max: 1440, onChange: minIntervalMinutes => update({ minIntervalMinutes }) }), h(Field, { label: '所在时区', children: h('input', { value: life.timeZone, required: true, maxLength: 100, placeholder: 'Asia/Shanghai', onChange: (event: ChangeEvent<HTMLInputElement>) => update({ timeZone: event.target.value }) }) })),
        h('div', { className: 'zs-grid' }, h(Field, { label: '安静时段开始', children: h('select', { value: life.quietStart, onChange: (event: ChangeEvent<HTMLSelectElement>) => update({ quietStart: Number(event.target.value) }) }, Array.from({ length: 24 }, (_, hour) => h('option', { key: hour, value: hour }, `${String(hour).padStart(2, '0')}:00`))) }), h(Field, { label: '安静时段结束', children: h('select', { value: life.quietEnd, onChange: (event: ChangeEvent<HTMLSelectElement>) => update({ quietEnd: Number(event.target.value) }) }, Array.from({ length: 24 }, (_, hour) => h('option', { key: hour, value: hour }, `${String(hour).padStart(2, '0')}:00`))) })), h('p', { className: 'zs-muted' }, '开始和结束相同时不设置安静时段。')),
      h('div', { className: 'zs-card zs-stack' }, h('h3', null, '可读取的聊天'),
        h('p', { className: 'zs-muted' }, '自主活动可以按需读取这些聊天的近期对话，再决定探索什么或分享什么。读取名单与发送名单分别保存；未开启主动联系时，也能读取已选聊天。'),
        choices.length ? h('div', { className: 'zs-targets' }, choices.map(([target, item]) => h(Check, { key: target, label: conversationName(item), hint: item.sessionId ? '已有会话记录' : '尚无会话记录；收到对话后才有内容可读', checked: readTargets.includes(target), onChange: checked => update({ readTargets: checked ? [...new Set([...readTargets, target])] : readTargets.filter(value => value !== target) }) }))) : h('p', { className: 'zs-muted' }, '请先在 QQ 与机器人聊天，或在目标群里 @ 它一次，再刷新目录。'),
        readTargets.filter(target => !known.has(target)).map(target => h(Check, { key: target, label: `已选目标 ${target}`, hint: '暂未出现在已知聊天中；可取消后重新选择。', checked: true, onChange: () => update({ readTargets: readTargets.filter(value => value !== target) }) }))),
      h('div', { className: 'zs-card zs-stack' }, h('h3', null, '主动联系'), h(Check, { label: '允许主动联系 QQ', hint: '只向下面明确选择的目标发送；内部活动不会自动变成 QQ 消息。', checked: life.allowContact, onChange: allowContact => update({ allowContact }) }),
        choices.length ? h('div', { className: 'zs-targets' }, choices.map(([target, item]) => h(Check, { key: target, label: conversationName(item), hint: item.active ? undefined : '目标当前不可用', checked: life.targets.includes(target), disabled: !item.active && !life.targets.includes(target), onChange: checked => update({ targets: checked ? [...new Set([...life.targets, target])] : life.targets.filter(value => value !== target) }) }))) : h('p', { className: 'zs-muted' }, '还没有已知的 QQ 会话。机器人收到消息后，会在这里出现。'),
        !choices.some(([, item]) => item.scope === 'group') ? h('p', { className: 'zs-muted' }, '还没发现群聊？在目标群里 @ 机器人一次，再刷新目录。') : null,
        h('details', null, h('summary', null, '手动添加联系目标'), h(Field, { label: '其他目标', hint: '每行一个。私聊填写 c2c:用户openid，群聊填写 group:群group_openid；群号不能替代 group_openid。', children: h('textarea', { value: extraTargets, rows: 3, maxLength: 12000, placeholder: 'c2c:用户openid\ngroup:群group_openid', onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { const value = event.target.value; setExtraTargets(value); update({ targets: [...new Set([...life.targets.filter(target => known.has(target)), ...targetLines(value)])] }); } }) }), invalidTargets ? h('p', { className: 'zs-danger' }, '有目标格式不正确，请检查每行的开头和 ID。') : null),
        h('div', { className: 'zs-grid' }, h(NumberField, { label: '每日主动联系上限', value: life.dailyContactLimit, min: 0, max: 100, onChange: dailyContactLimit => update({ dailyContactLimit }) }), h(NumberField, { label: '同一目标联系间隔（分钟）', value: life.contactCooldownMinutes, min: 5, max: 10080, onChange: contactCooldownMinutes => update({ contactCooldownMinutes }) })),
        h(Check, { label: '允许自主发送表情', checked: life.allowMemes, onChange: allowMemes => update({ allowMemes }) }), h(Check, { label: '允许自主生成与发送语音', hint: '仍需启用语音服务并配置密钥。', checked: life.allowSpeech, onChange: allowSpeech => update({ allowSpeech }) })),
      h(SettingsFooter, { busy: saving, dirty: dirty && !invalidTargets }))),
  );
}

function SecurityPanel({ draft, setDraft, save, saving, dirty, state, feedback, refreshState }: SettingsEditorProps & { state: State; feedback: Feedback; refreshState: () => Promise<void> }): ReactNode {
  const task = useTask(feedback); const [selected, setSelected] = useState('');
  const candidates = useMemo(() => {
    const values = new Map<string, AdministratorCandidate>();
    for (const candidate of state.administratorCandidates ?? []) {
      const previous = values.get(candidate.senderId);
      if (!previous || candidate.lastSeenAt >= previous.lastSeenAt) values.set(candidate.senderId, { ...candidate, name: candidate.name || previous?.name });
      else if (!previous.name && candidate.name) values.set(candidate.senderId, { ...previous, name: candidate.name });
    }
    return [...values.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }, [state.administratorCandidates]);
  const administrators = draft.security.administrators;
  const available = candidates.filter(candidate => candidate.observed && !administrators.includes(candidate.senderId));
  useEffect(() => { if (selected && !available.some(candidate => candidate.senderId === selected)) setSelected(''); }, [available, selected]);
  const shortId = (senderId: string): string => senderId.length > 10 ? `…${senderId.slice(-8)}` : senderId;
  const userName = (candidate: AdministratorCandidate | undefined, senderId: string): string => candidate?.name?.trim() || `${candidate?.observed ? 'QQ 用户' : '已保存的管理员'} ${shortId(senderId)}`;
  const originName = (candidate: AdministratorCandidate): string => candidate.scope === 'group'
    ? state.conversations.find(item => item.scope === 'group' && item.peerId === candidate.peerId)?.alias || state.conversations.find(item => item.scope === 'group' && item.peerId === candidate.peerId)?.title || '群聊'
    : '私聊';
  const updateAdministrators = (values: string[]): void => setDraft({ ...draft, security: { ...draft.security, administrators: values } });
  return h('form', { className: 'zs-stack', onSubmit: save }, h('fieldset', { disabled: saving, className: 'zs-stack' },
    h('div', { className: 'zs-card zs-stack' }, h('div', { className: 'zs-row' }, h('h3', { className: 'zs-spacer' }, 'QQ 管理员'),
      h(Button, { disabled: task.busy, onClick: () => { void task.run(async () => { await refreshState(); feedback('可选用户已刷新。'); }); } }, task.busy ? '正在刷新…' : '刷新可选用户')),
      h('p', { className: 'zs-muted' }, '从聊过天的用户中选择管理员，保存后生效。'),
      h('div', { className: 'zs-stack' }, h(Field, { label: '添加管理员', children: h('select', { value: selected, disabled: task.busy || !available.length || administrators.length >= 100, onChange: (event: ChangeEvent<HTMLSelectElement>) => setSelected(event.target.value) },
        h('option', { value: '' }, '选择一位聊过天的用户'), available.map(candidate => h('option', { key: candidate.senderId, value: candidate.senderId }, `${userName(candidate, candidate.senderId)} · ${originName(candidate)} · ${shortId(candidate.senderId)}`))) }),
        h('div', null, h(Button, { disabled: task.busy || !selected || administrators.length >= 100, onClick: () => { if (!available.some(candidate => candidate.senderId === selected)) return; updateAdministrators([...new Set([...administrators, selected])]); setSelected(''); } }, '添加为管理员'))),
      !candidates.some(candidate => candidate.observed) ? h('p', { className: 'zs-muted' }, '还没有可选用户。请让对方先给机器人发一条消息，再刷新。') : !available.length ? h('p', { className: 'zs-muted' }, '收到过消息的用户都已添加。') : null,
      administrators.length >= 100 ? h('p', { className: 'zs-muted' }, '管理员名单已满，请先移除一位。') : null,
      administrators.length ? h('ul', { 'aria-label': '当前管理员', style: { listStyle: 'none', margin: 0, padding: 0 } }, administrators.map(senderId => {
        const candidate = candidates.find(item => item.senderId === senderId); const label = userName(candidate, senderId);
        return h('li', { key: senderId, className: 'zs-record zs-row' }, h('div', { className: 'zs-spacer' }, h('p', { className: 'zs-record-title' }, label), h('p', { className: 'zs-muted zs-small' }, candidate?.observed ? originName(candidate) : '已保留原来的管理员设置')),
          h('button', { type: 'button', className: 'zs-button zs-danger', 'aria-label': `移除管理员 ${label}`, disabled: task.busy, onClick: () => updateAdministrators(administrators.filter(value => value !== senderId)) }, '移除'));
      })) : h('p', { className: 'zs-muted' }, '尚未设置管理员。')),
    h('div', { className: 'zs-card zs-stack' }, h('h3', null, '群聊回复节奏'),
      h('p', { className: 'zs-muted' }, '先收集连续消息，由 AI 决定是否回复。选择跳过时不会向 QQ 发送任何占位文字或内部进度。机器人只能接收 QQ 平台实际下发的消息。'),
      h('div', { className: 'zs-grid' },
        h(NumberField, { label: '收到最后一条后等待（毫秒）', value: draft.group.waitMs, min: 0, max: 10000, onChange: waitMs => setDraft({ ...draft, group: { ...draft.group, waitMs } }) }),
        h(NumberField, { label: '连续消息最多等待（毫秒）', value: draft.group.maxWaitMs, min: 1000, max: 30000, onChange: maxWaitMs => setDraft({ ...draft, group: { ...draft.group, maxWaitMs } }) }))),
    h(SettingsFooter, { busy: saving || task.busy, dirty })));
}

function ServiceCredential({ provider, state, feedback, refreshState }: { provider: 'cloudflare' | 'apimart'; state: State; feedback: Feedback; refreshState: () => Promise<void> }): ReactNode {
  const [secret, setSecret] = useState(''); const task = useTask(feedback); const label = provider === 'cloudflare' ? 'Cloudflare API Token' : 'ApiMart API Key';
  return h('form', { className: 'zs-card zs-stack', onSubmit: (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void task.run(async () => { const value = secret; setSecret(''); await request('/credential', 'PUT', { provider, value }); await refreshState(); feedback(`${label} 已保存。`); }); } },
    h('div', { className: 'zs-row' }, h('h3', { className: 'zs-spacer' }, label), h('span', { className: 'zs-badge' }, state.credentials[provider] ? '已配置' : '尚未配置')),
    h(Field, { label: '密钥', hint: provider === 'cloudflare' ? '需要 Browser Rendering - Edit 权限。密钥只保存在 DSH 凭据服务，不会回显。' : '只保存在 DSH 凭据服务，不会加入聊天或浏览器草稿。', children: h('input', { type: 'password', autoComplete: 'off', value: secret, maxLength: 8192, disabled: task.busy, onChange: (event: ChangeEvent<HTMLInputElement>) => setSecret(event.target.value) }) }),
    h('div', { className: 'zs-actions' }, h(Button, { type: 'submit', disabled: task.busy || !secret.trim() }, '保存密钥'), h(Button, { danger: true, disabled: task.busy || !state.credentials[provider], onClick: () => { void task.run(async () => { setSecret(''); await request('/credential', 'PUT', { provider, value: null }); await refreshState(); feedback(`${label} 已移除。`); }); } }, '移除密钥')));
}

function ServicesPanel({ state, feedback, refreshState, draft, setDraft, save, saving, dirty }: SettingsEditorProps & { state: State; feedback: Feedback; refreshState: () => Promise<void> }): ReactNode {
  const [browser, setBrowser] = useState<{ active: number; usedMsToday: number; cleanupPending: number }>(); const task = useTask(feedback);
  const refreshBrowser = useCallback(async (): Promise<void> => { const value = await request<{ browser: { active: number; usedMsToday: number; cleanupPending: number } }>('/services/status'); setBrowser(value.browser); }, []);
  useEffect(() => { void refreshBrowser().catch(error => feedback(message(error), true)); }, [refreshBrowser, feedback]);
  const setBrowserSetting = (patch: Partial<Settings['browser']>): void => setDraft({ ...draft, browser: { ...draft.browser, ...patch } });
  const setImageSetting = (patch: Partial<Settings['images']>): void => setDraft({ ...draft, images: { ...draft.images, ...patch } });
  const setDeploymentSetting = (patch: Partial<Settings['deployments']>): void => setDraft({ ...draft, deployments: { ...draft.deployments, ...patch } });
  return h('div', { className: 'zs-stack' },
    h(ServiceCredential, { provider: 'cloudflare', state, feedback, refreshState }), h(ServiceCredential, { provider: 'apimart', state, feedback, refreshState }),
    h('form', { className: 'zs-stack', onSubmit: save }, h('fieldset', { disabled: saving, className: 'zs-stack' },
      h('div', { className: 'zs-card zs-stack' }, h('h3', null, 'Cloudflare 云浏览器'),
        h(Check, { label: '启用云浏览器', hint: '通过 Playwright 浏览网页。任务结束、取消或报错时释放远端资源。', checked: draft.browser.enabled, onChange: enabled => setBrowserSetting({ enabled }) }),
        h(Field, { label: 'Cloudflare 账户 ID', children: h('input', { value: draft.browser.accountId, maxLength: 100, onChange: (event: ChangeEvent<HTMLInputElement>) => setBrowserSetting({ accountId: event.target.value.trim() }) }) }),
        h('div', { className: 'zs-grid' }, h(NumberField, { label: '同时使用的浏览器上限', value: draft.browser.maxConcurrent, min: 1, max: 10, onChange: maxConcurrent => setBrowserSetting({ maxConcurrent }) }),
          h(NumberField, { label: '单次任务最长秒数', value: draft.browser.maxSessionMs / 1000, min: 1, max: 600, onChange: value => setBrowserSetting({ maxSessionMs: value * 1000 }) }),
          h(NumberField, { label: '空闲后释放（秒）', value: draft.browser.idleTimeoutMs / 1000, min: 1, max: 60, onChange: value => setBrowserSetting({ idleTimeoutMs: value * 1000 }) }),
          h(NumberField, { label: '每日浏览器时间预算（分钟）', value: draft.browser.dailyBudgetMs / 60000, min: 1, max: 1440, onChange: value => setBrowserSetting({ dailyBudgetMs: value * 60000 }) }))),
      h('div', { className: 'zs-card zs-stack' }, h('h3', null, 'ApiMart 图片生成'),
        h(Check, { label: '启用图片生成', checked: draft.images.enabled, onChange: enabled => setImageSetting({ enabled }) }),
        h('p', { className: 'zs-muted' }, '模型：gemini-nano-banana-2.1-ext。每次一张，默认 1K；不会自动切换其他计费模型。'),
        h('div', { className: 'zs-grid' }, h(Field, { label: '默认画质', children: h('select', { value: draft.images.resolution, onChange: (event: ChangeEvent<HTMLSelectElement>) => setImageSetting({ resolution: event.target.value as Settings['images']['resolution'] }) }, ['1K', '2K', '4K'].map(value => h('option', { value, key: value }, value))) }),
          h(NumberField, { label: '每日提交图片上限', value: draft.images.dailyLimit, min: 1, max: 1000, onChange: dailyLimit => setImageSetting({ dailyLimit }) }))),
      h('div', { className: 'zs-card zs-stack' }, h('h3', null, '临时网页部署'),
        h(Check, { label: '启用临时网页部署', hint: '无需登录正式 Cloudflare 账户。网页有 60 分钟认领窗口，未认领会自动删除。', checked: draft.deployments.enabled, onChange: enabled => setDeploymentSetting({ enabled }) }),
        h(Check, { label: '我已阅读并接受 Cloudflare 服务条款与隐私政策', checked: draft.deployments.acceptedTerms, onChange: acceptedTerms => setDeploymentSetting({ acceptedTerms }) }),
        h('p', { className: 'zs-muted' }, h('a', { href: 'https://www.cloudflare.com/terms/', target: '_blank', rel: 'noreferrer noopener' }, '服务条款'), ' · ', h('a', { href: 'https://www.cloudflare.com/privacypolicy/', target: '_blank', rel: 'noreferrer noopener' }, '隐私政策')),
        h(NumberField, { label: '同时保留的临时网页上限', value: draft.deployments.maxActive, min: 1, max: 20, onChange: maxActive => setDeploymentSetting({ maxActive }) }),
        h('p', { className: 'zs-muted' }, '预览链接可以分享。认领链接代表账户所有权，只在此管理页查看。到期重新部署将获得新地址。')),
      h(SettingsFooter, { busy: saving, dirty }))),
    h('div', { className: 'zs-card zs-stack' }, h('h3', null, '浏览器资源'),
      h('p', { className: 'zs-muted' }, browser ? `运行中：${browser.active}　今日已预留：${Math.ceil(browser.usedMsToday / 1000)} 秒　待清理：${browser.cleanupPending}` : '正在读取使用情况…'),
      h('div', { className: 'zs-actions' }, h(Button, { disabled: task.busy, onClick: () => { void task.run(refreshBrowser); } }, '刷新状态'),
        h(Button, { disabled: task.busy, onClick: () => { void task.run(async () => { const value = await request<{ closed: boolean }>('/browser/close', 'POST', {}); await refreshBrowser(); feedback(value.closed ? '本插件当前浏览器已关闭。' : '关闭请求已执行，仍有远端会话待确认，请重试资源清理。', !value.closed); }); } }, '关闭当前浏览器'),
        h(Button, { disabled: task.busy, onClick: () => { void task.run(async () => { await request('/browser/recover', 'POST', {}); await refreshBrowser(); feedback('已重试清理本插件遗留会话。'); }); } }, '重试资源清理'))),
    h(ImageStudio, { feedback, enabled: state.settings.images.enabled }), h(DeploymentList, { feedback }));
}

interface GeneratedImage { id: string; taskId?: string; status: string; createdAt: string; mimeType?: string; delivery: string; selfPortrait: boolean; notice?: string }
function ImageStudio({ feedback, enabled }: { feedback: Feedback; enabled: boolean }): ReactNode {
  const [items, setItems] = useState<GeneratedImage[]>([]); const [prompt, setPrompt] = useState(''); const [selfPortrait, setSelfPortrait] = useState(false); const [selected, setSelected] = useState<GeneratedImage>(); const task = useTask(feedback);
  const load = useCallback(async (signal?: AbortSignal): Promise<void> => { const value = await request<{ items: GeneratedImage[] }>('/images', 'GET', undefined, signal); if (!signal?.aborted) setItems(value.items); }, []);
  useEffect(() => { const controller = new AbortController(); setSelected(undefined); void load(controller.signal).catch(error => { if (!controller.signal.aborted) feedback(message(error), true); }); return () => controller.abort(); }, [load, feedback]);
  const media = useMedia(selected?.status === 'completed' ? `${API}/images/media?${new URLSearchParams({ id: selected.id })}` : undefined);
  return h('div', { className: 'zs-card zs-stack' }, h('div', { className: 'zs-row' }, h('h3', { className: 'zs-spacer' }, '所有对话的图片记录'), h(Button, { disabled: task.busy, onClick: () => { void task.run(load); } }, '刷新记录')),
    h('form', { className: 'zs-stack', onSubmit: (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void task.run(async () => { const value = await request<{ result: GeneratedImage }>('/images', 'POST', { prompt, selfPortrait }); await load(); setSelected(value.result); feedback(value.result.status === 'completed' ? '图片已生成，管理页不会发送至QQ。' : '图片任务已保存，可稍后查询结果。'); }); } },
      h(Field, { label: '画面描述', children: h('textarea', { value: prompt, rows: 3, maxLength: 8000, disabled: task.busy, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setPrompt(event.target.value) }) }),
      h(Check, { label: '绘制自己的形象', hint: '自动附带已上传的人设原图。', checked: selfPortrait, disabled: task.busy, onChange: setSelfPortrait }),
      h('div', null, h(Button, { type: 'submit', primary: true, disabled: task.busy || !enabled || !prompt.trim() }, task.busy ? '正在处理，请稍候…' : '生成一张图片'))),
    media.objectUrl ? h('div', { className: 'zs-preview' }, h('img', { src: media.objectUrl, alt: selected?.selfPortrait ? '生成的自画像' : '生成图片', style: { maxWidth: '100%' } })) : null,
    items.length ? h('div', null, items.map(item => h('div', { key: item.id, className: 'zs-record' }, h('div', { className: 'zs-record-head' }, h('span', null, `${date(item.createdAt)} · ${item.selfPortrait ? '自画像' : '图片'} · ${item.status === 'completed' ? '已生成' : item.status === 'failed' ? '生成失败' : item.status === 'unknown' ? '提交结果待确认' : '处理中'}`),
      item.status === 'completed' ? h(Button, { onClick: () => setSelected(item) }, '查看') : item.taskId ? h(Button, { disabled: task.busy, onClick: () => { void task.run(async () => { const value = await request<{ result: GeneratedImage }>('/images/status', 'POST', { id: item.id }); await load(); setSelected(value.result); }); } }, '查询已有任务') : null), item.notice ? h('p', { className: 'zs-muted' }, item.notice) : null))) : h('p', { className: 'zs-muted' }, '还没有生成图片，所有对话的生成记录会显示在这里。'));
}

interface DeploymentRecord { id: string; previewUrl?: string; status: string; expiresAt: string; createdAt: string }
function DeploymentList({ feedback }: { feedback: Feedback }): ReactNode {
  const [items, setItems] = useState<DeploymentRecord[]>([]); const [claim, setClaim] = useState<{ id: string; url: string }>(); const task = useTask(feedback);
  const load = useCallback(async (signal?: AbortSignal): Promise<void> => { const value = await request<{ items: DeploymentRecord[] }>('/deployments', 'GET', undefined, signal); if (!signal?.aborted) setItems(value.items); }, []);
  useEffect(() => { const controller = new AbortController(); setClaim(undefined); void load(controller.signal).catch(error => { if (!controller.signal.aborted) feedback(message(error), true); }); return () => controller.abort(); }, [load, feedback]);
  return h('div', { className: 'zs-card zs-stack' }, h('div', { className: 'zs-row' }, h('h3', { className: 'zs-spacer' }, '临时网页'), h(Button, { disabled: task.busy, onClick: () => { void task.run(load); } }, '刷新记录')),
    h('p', { className: 'zs-muted' }, '所有对话的网页共用这份记录。在 QQ 中请 AI 制作网页并临时部署，完成后可以在这里查看预览和认领。'),
    items.length ? items.map(item => h('div', { key: item.id, className: 'zs-record zs-stack' }, h('p', null, `到期：${date(item.expiresAt)} · ${{ ready: '可访问', preparing: '准备中', deploying: '部署中', unknown: '结果待确认', failed: '失败', expired: '临时授权已到期', deleted: '已移除' }[item.status] || item.status}`),
      item.previewUrl ? h('a', { href: item.previewUrl, target: '_blank', rel: 'noreferrer noopener' }, '打开预览网页') : null,
      h('div', { className: 'zs-actions' }, item.status === 'unknown' ? h(Button, { disabled: task.busy, onClick: () => { void task.run(async () => { await request('/deployments/status', 'POST', { id: item.id }); await load(); feedback('已查询原部署，没有重新创建账户。'); }); } }, '查询部署结果') : null, h(Button, { disabled: task.busy || item.status !== 'ready', onClick: () => { void task.run(async () => { const value = await request<{ claimUrl: string }>(`/deployments/claim?${new URLSearchParams({ id: item.id })}`); setClaim({ id: item.id, url: value.claimUrl }); }); } }, '查看认领链接'),
        h(Button, { danger: true, disabled: task.busy, onClick: () => { void task.run(async () => { await request('/deployments', 'DELETE', { id: item.id }); setClaim(undefined); await load(); feedback('已移除临时部署。'); }); } }, '移除')),
      claim?.id === item.id ? h('a', { href: claim.url, target: '_blank', rel: 'noreferrer noopener' }, '前往 Cloudflare 认领（请勿分享此链接）') : null)) : h('p', { className: 'zs-muted' }, '还没有临时网页，所有对话的网页记录会显示在这里。'));
}

function backupPasswordHeader(password: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(password)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function backupSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${Math.max(1, Math.ceil(bytes / 1024))} KiB`;
}

function saveBackupDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
  anchor.href = url; anchor.download = fileName; anchor.style.display = 'none'; document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function BackupPanel({ feedback, onRestoreBusy }: { feedback: Feedback; onRestoreBusy: (busy: boolean) => void }): ReactNode {
  const [exportPassword, setExportPassword] = useState(''); const [confirmation, setConfirmation] = useState(''); const [includeCredentials, setIncludeCredentials] = useState(true);
  const [file, setFile] = useState<File>(); const [restorePassword, setRestorePassword] = useState(''); const [prepared, setPrepared] = useState<PreparedBackup>(); const [restored, setRestored] = useState<BackupRestored>();
  const [status, setStatus] = useState<BackupStatus>();
  type Operation = { kind: 'export' | 'preview' | 'restore' | 'plugin' | 'activate'; controller?: AbortController };
  const [mode, setMode] = useState<Operation['kind']>(); const operation = useRef<Operation>(); const mounted = useRef(true); const previewGeneration = useRef(0); const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void request<BackupStatus>('/backup/status', 'GET', undefined, controller.signal).then(value => { if (!controller.signal.aborted) setStatus(value); }).catch(error => { if (!controller.signal.aborted) feedback(message(error), true); });
    return () => { mounted.current = false; controller.abort(); operation.current?.controller?.abort(); };
  }, [feedback]);
  const busy = mode !== undefined;
  const validPassword = (password: string): boolean => password.length >= 8 && password.length <= 1024;
  const begin = (kind: Operation['kind']): Operation | undefined => {
    if (operation.current) return;
    const current: Operation = { kind, ...(kind === 'restore' || kind === 'activate' ? {} : { controller: new AbortController() }) };
    operation.current = current; setMode(kind);
    if (kind === 'restore') onRestoreBusy(true);
    return current;
  };
  const finish = (current: Operation): void => {
    if (operation.current === current) operation.current = undefined;
    if (mounted.current) setMode(undefined);
    if (current.kind === 'restore') onRestoreBusy(false);
  };
  const invalidatePreview = (): void => { previewGeneration.current++; setPrepared(undefined); setRestored(undefined); };
  const cancel = (): void => { operation.current?.controller?.abort(); };
  const exportBackup = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!validPassword(exportPassword)) { feedback('备份密码须为8至1024个字符。', true); return; }
    if (exportPassword !== confirmation) { feedback('两次输入的备份密码不一致。', true); return; }
    const current = begin('export'); if (!current) return;
    void (async () => {
      try {
        const response = await fetch(`${API}/backup/export`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: exportPassword, includeCredentials }), signal: current.controller!.signal });
        if (!response.ok) throw await responseError(response);
        if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/octet-stream')) throw new Error('备份服务未返回有效的加密文件，请刷新后重试。');
        const blob = await response.blob(); current.controller!.signal.throwIfAborted();
        if (!blob.size) throw new Error('生成的备份为空，请重新导出。');
        saveBackupDownload(blob, `${PLUGIN_NAME}-${new Date().toISOString().replace(/[:.]/g, '-')}.zeta-backup`);
        if (mounted.current) { setExportPassword(''); setConfirmation(''); feedback('加密备份已生成并开始下载，请保存好备份文件和密码。'); }
      } catch (error) { if (mounted.current) feedback(current.controller!.signal.aborted ? '已取消生成备份。' : message(error), !current.controller!.signal.aborted); }
      finally { finish(current); }
    })();
  };
  const downloadPlugin = (): void => {
    const current = begin('plugin'); if (!current) return;
    void (async () => {
      try {
        const response = await fetch(`${API}/backup/plugin`, { credentials: 'same-origin', cache: 'no-store', signal: current.controller!.signal });
        if (!response.ok) throw await responseError(response);
        const blob = await response.blob(); current.controller!.signal.throwIfAborted();
        if (!blob.size) throw new Error('插件安装包为空，请刷新后重试。');
        saveBackupDownload(blob, `${PLUGIN_NAME}-plugin.tgz`);
        if (mounted.current) feedback('本版本插件已开始下载，不包含聊天、素材或密钥。请在新设备先安装DSH和此插件，再导入加密备份。');
      } catch (error) { if (mounted.current) feedback(current.controller!.signal.aborted ? '已取消下载插件。' : message(error), !current.controller!.signal.aborted); }
      finally { finish(current); }
    })();
  };
  const previewBackup = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!file || !file.size || file.size > 2 * 1024 ** 3) { feedback('请选择不超过2 GiB的非空备份文件。', true); return; }
    if (!validPassword(restorePassword)) { feedback('备份密码须为8至1024个字符。', true); return; }
    const current = begin('preview'); if (!current) return;
    invalidatePreview(); const generation = previewGeneration.current;
    void (async () => {
      try {
        const response = await fetch(`${API}/backup/preview`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/octet-stream', 'x-zeta-backup-password': backupPasswordHeader(restorePassword) }, body: file, signal: current.controller!.signal });
        if (!response.ok) throw await responseError(response);
        let value: PreparedBackup;
        try { value = await response.json() as PreparedBackup; } catch { throw new Error('无法读取备份校验结果，请重新校验。'); }
        current.controller!.signal.throwIfAborted();
        if (!value || typeof value.token !== 'string' || !value.token || !value.preview) throw new Error('备份校验结果不完整，请重新校验。');
        if (mounted.current && previewGeneration.current === generation) { setPrepared(value); feedback(value.preview.canRestore ? '备份已校验，请核对下方摘要后再决定是否恢复。' : '备份已校验，当前存在无法恢复的问题，请查看摘要。', !value.preview.canRestore); }
      } catch (error) { if (mounted.current) feedback(current.controller!.signal.aborted ? '已取消上传与校验，当前数据未改变。' : message(error), !current.controller!.signal.aborted); }
      finally { finish(current); }
    })();
  };
  const restoreBackup = (): void => {
    if (!prepared?.preview.canRestore) return;
    const token = prepared.token; const current = begin('restore'); if (!current) return;
    setRestorePassword('');
    void (async () => {
      try {
        // Do not interrupt the server's restore after the user accepts the
        // preview, because it may already be committing persistent files.
        const result = await request<BackupRestored>('/backup/restore', 'POST', { token });
        if (result.restored !== true) throw new Error('恢复结果尚未确认，请查看DSH运行状态。');
        if (mounted.current) {
          setRestored(result); setPrepared(undefined); setFile(undefined); if (fileInput.current) fileInput.current.value = '';
          feedback('备份已恢复。QQ连接和自主生活均保持暂停；请按下方步骤启用新设备连接，再重新加载DSH。');
          try { const value = await request<BackupStatus>('/backup/status'); if (mounted.current) setStatus(value); }
          catch { feedback('备份已恢复，暂时无法读取连接启用状态。请重新加载DSH后返回此页。', true); }
        }
      } catch (error) { if (mounted.current) { setPrepared(undefined); feedback(message(error), true); } }
      finally { finish(current); }
    })();
  };
  const activate = (): void => {
    if (!status?.canActivate) return;
    const current = begin('activate'); if (!current) return;
    void (async () => {
      try {
        const result = await request<{ restartRequired: true }>('/backup/activate', 'POST', {});
        if (result.restartRequired !== true) throw new Error('连接启用结果尚未确认，请刷新状态后重试。');
        if (mounted.current) { setStatus(previous => ({ ...previous!, canActivate: false, restartRequired: true })); feedback('迁移后的QQ连接已启用，请重新加载DSH使其生效。自主生活仍保持暂停，需单独手动开启。'); }
      } catch (error) { if (mounted.current) feedback(message(error), true); }
      finally { finish(current); }
    })();
  };
  const preview = prepared?.preview;
  return h('div', { className: 'zs-stack' },
    h('div', { className: 'zs-notice' }, '备份包含插件配置、记忆、表情、生成的语音、插件关联会话的完整DSH聊天记录，以及当前插件文件。导出使用已保存的数据，请先保存需要保留的设置修改。新电脑先安装DSH和下方的本版本插件，再导入加密备份。'),
    status?.pendingRestore ? h('div', { className: 'zs-notice zs-error', role: 'alert' }, '检测到尚未完成的恢复。QQ连接暂时保持暂停，请重新选择原备份并校验后继续恢复。') : status?.maintenance ? h('div', { className: 'zs-notice', role: 'status' }, '正在维护迁移数据，QQ连接暂时保持暂停。') : null,
    h('form', { className: 'zs-card zs-stack', onSubmit: exportBackup }, h('h3', null, '导出加密备份'),
      h('fieldset', { disabled: busy, className: 'zs-stack' },
        h(Field, { label: '设置备份密码', hint: '至少8个字符。请单独保存密码；页面不会把密码写入草稿或浏览器存储。', children: h('input', { type: 'password', autoComplete: 'new-password', value: exportPassword, required: true, minLength: 8, maxLength: 1024, onChange: (event: ChangeEvent<HTMLInputElement>) => setExportPassword(event.target.value) }) }),
        h(Field, { label: '再次输入备份密码', children: h('input', { type: 'password', autoComplete: 'new-password', value: confirmation, required: true, minLength: 8, maxLength: 1024, onChange: (event: ChangeEvent<HTMLInputElement>) => setConfirmation(event.target.value) }) }),
        confirmation && confirmation !== exportPassword ? h('p', { className: 'zs-danger' }, '两次输入的密码还不一致。') : null,
        h(Check, { label: '一并备份已配置的密钥', hint: '密钥会随备份加密保存，恢复时可迁移到新设备。', checked: includeCredentials, onChange: setIncludeCredentials }),
        h('div', { className: 'zs-actions' }, h(Button, { type: 'submit', primary: true, disabled: busy || !validPassword(exportPassword) || confirmation !== exportPassword }, mode === 'export' ? '正在生成并下载…' : '导出加密备份'), h(Button, { disabled: busy, onClick: downloadPlugin }, mode === 'plugin' ? '正在下载插件…' : '下载本版本插件')),
        h('p', { className: 'zs-muted' }, '插件安装包只包含代码，不包含个人数据；完整加密备份中也保留了当前插件分发文件。')),
      mode === 'export' ? h('div', { className: 'zs-actions', role: 'status' }, h('span', { className: 'zs-muted zs-spacer' }, '正在整理并加密备份，较大的备份需要一些时间。'), h(Button, { onClick: cancel }, '取消导出')) : mode === 'plugin' ? h(Button, { onClick: cancel }, '取消下载') : null),
    h('form', { className: 'zs-card zs-stack', onSubmit: previewBackup }, h('h3', null, '选择备份并校验'),
      h('p', { className: 'zs-muted' }, '选择文件后先检查内容与兼容性。校验不会恢复或覆盖当前数据。'),
      h('fieldset', { disabled: busy, className: 'zs-stack' },
        h(Field, { label: '备份文件', hint: '选择 .zeta-backup 文件，最大2 GiB。', children: h('input', { ref: fileInput, type: 'file', accept: '.zeta-backup,application/octet-stream', onChange: (event: ChangeEvent<HTMLInputElement>) => {
          invalidatePreview(); const selected = event.target.files?.[0];
          if (selected && (!selected.size || selected.size > 2 * 1024 ** 3)) { setFile(undefined); event.target.value = ''; feedback('请选择不超过2 GiB的非空备份文件。', true); return; }
          setFile(selected);
        } }) }),
        file ? h('p', { className: 'zs-muted' }, `${file.name} · ${backupSize(file.size)}`) : null,
        h(Field, { label: '备份的恢复密码', children: h('input', { type: 'password', autoComplete: 'off', value: restorePassword, required: true, minLength: 8, maxLength: 1024, onChange: (event: ChangeEvent<HTMLInputElement>) => { setRestorePassword(event.target.value); invalidatePreview(); } }) }),
        h('div', { className: 'zs-actions' }, h(Button, { type: 'submit', primary: true, disabled: busy || !file || !validPassword(restorePassword) }, mode === 'preview' ? '正在上传并校验…' : '校验并查看摘要'))),
      mode === 'preview' ? h('div', { className: 'zs-actions', role: 'status' }, h('span', { className: 'zs-muted zs-spacer' }, '正在上传并检查备份，当前数据未改变。'), h(Button, { onClick: cancel }, '取消校验')) : null),
    preview ? h('div', { className: 'zs-card zs-stack' }, h('h3', null, '恢复前核对'),
      h('p', { className: 'zs-muted' }, `创建时间：${date(preview.createdAt)} · 插件 ${preview.pluginVersion} · DSH ${preview.dshVersion} · 备份格式 ${preview.formatVersion}`),
      h('div', { className: 'zs-stats' }, [['聊天会话', preview.sessions], ['会话目录', preview.conversations], ['长期记忆', preview.memoryItems], ['文件', preview.files]].map(([label, value]) => h('div', { className: 'zs-card', key: label }, h('p', { className: 'zs-muted' }, label), h('p', { className: 'zs-stat' }, value)))),
      h('p', { className: 'zs-muted' }, `备份内容：${backupSize(preview.bytes)} · ${preview.includesCredentials ? '包含加密保存的密钥' : '未包含密钥，恢复后需重新配置'}`),
      preview.warnings.length ? h('div', { className: 'zs-notice' }, h('p', null, '恢复提示'), h('ul', null, preview.warnings.map((warning, index) => h('li', { key: index }, warning)))) : null,
      preview.conflicts.length ? h('div', { className: 'zs-notice zs-error', role: 'alert' }, h('p', null, '当前存在冲突，无法恢复'), h('ul', null, preview.conflicts.map((conflict, index) => h('li', { key: index }, conflict)))) : null,
      h('p', { className: 'zs-body' }, '恢复将替换当前插件设置；已有聊天或素材发生冲突时会拒绝覆盖。恢复后QQ连接与自主生活均默认暂停，需确认旧设备已断开后启用新设备的QQ连接；自主生活需在重新加载DSH后单独手动开启。'),
      !preview.canRestore ? h('p', { className: 'zs-danger' }, '该备份当前无法恢复，当前数据未改变。请处理上面的问题后重新校验。') : null,
      h('div', { className: 'zs-actions' }, h(Button, { danger: true, disabled: busy || !preview.canRestore, onClick: restoreBackup }, mode === 'restore' ? '正在恢复，请保持页面打开…' : '恢复到本机'), mode === 'restore' ? h(Button, { disabled: true }, '恢复期间无法取消') : null)) : null,
    restored || status?.canActivate || status?.restartRequired ? h('div', { className: 'zs-card zs-stack', role: 'status' }, h('h3', null, restored ? '恢复完成' : '迁移后的QQ连接'),
      restored ? h('p', null, `已恢复${restored.sessions}个聊天会话、${restored.files}个文件。重新加载DSH后可继续原来的聊天。`) : null,
      status?.canActivate ? h('p', { className: 'zs-muted' }, 'QQ连接当前保持暂停。请先关闭旧设备上的机器人连接，再启用本机，避免两台电脑同时连接同一个QQ机器人。') : h('p', { className: 'zs-muted' }, '连接设置已保存，请重新加载DSH使其生效。'),
      h('p', { className: 'zs-muted' }, '下方操作只启用迁移后的QQ连接；自主生活仍保持暂停，需在重新加载后查看设置并手动开启。'),
      status?.canActivate ? h('div', { className: 'zs-actions' }, h(Button, { primary: true, disabled: busy || status.pendingRestore, onClick: activate }, mode === 'activate' ? '正在保存连接设置…' : '启用迁移后的QQ连接')) : null,
      restored?.warnings.length ? h('ul', null, restored.warnings.map((warning, index) => h('li', { key: index }, warning))) : null) : null,
  );
}

/** One browser-only settings surface. No host runtime imports or credential persistence. */
export function ZetaPanel(): ReactNode {
  useStyles();
  const [state, setState] = useState<State>(); const [draft, setDraft] = useState<Settings>(); const [tab, setTab] = useState<Tab>('overview');
  const [notice, setNotice] = useState<{ text: string; error: boolean }>(); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [identityBusy, setIdentityBusy] = useState(false); const identityOperation = useRef<AbortController>(); const identityDraftRevision = useRef<number>();
  const savePending = useRef(false); const tabPrefix = useId();
  const feedback = useCallback<Feedback>((text, error = false) => setNotice({ text, error }), []);
  const refreshState = useCallback(async (): Promise<void> => { const result = await request<State>('/state'); setState(result); setDraft(current => {
    const value = current ?? structuredClone(result.settings);
    if (value.name === result.settings.name && value.persona === result.settings.persona && JSON.stringify(value.habits ?? []) === JSON.stringify(result.settings.habits ?? [])) identityDraftRevision.current = result.identity?.revision;
    return value;
  }); }, []);
  useEffect(() => { const controller = new AbortController(); void request<State>('/state', 'GET', undefined, controller.signal).then(result => { if (!controller.signal.aborted) { setState(result); setDraft(structuredClone(result.settings)); identityDraftRevision.current = result.identity?.revision; } }).catch(error => { if (!controller.signal.aborted) feedback(message(error), true); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }); return () => { controller.abort(); identityOperation.current?.abort(); }; }, [feedback]);
  const identityAction = (reset: boolean): void => {
    if (identityOperation.current || savePending.current || restoreBusy) return;
    const controller = new AbortController(); identityOperation.current = controller; setIdentityBusy(true);
    void request<IdentitySnapshot>(reset ? '/identity/reset' : '/identity', reset ? 'POST' : 'GET', reset ? { expected_revision: state?.identity?.revision ?? 0 } : undefined, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      const fields = { name: value.name, persona: value.persona, habits: [...value.habits] };
      identityDraftRevision.current = value.revision;
      setDraft(current => current ? { ...current, ...fields } : current);
      setState(current => current ? { ...current, settings: { ...current.settings, ...fields }, identity: { revision: value.revision, updatedAt: value.updatedAt, history: value.history } } : current);
      feedback(reset ? '已恢复最新默认人设。其他功能的设置与未保存草稿保持不变。' : '已载入最新名字、人设和习惯。其他功能的草稿已保留。');
    }).catch(error => { if (!controller.signal.aborted) feedback(message(error), true); }).finally(() => { if (identityOperation.current === controller) { identityOperation.current = undefined; setIdentityBusy(false); } });
  };
  const dirty = !!state && !!draft && JSON.stringify(state.settings) !== JSON.stringify(draft);
  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault(); if (!draft || savePending.current || restoreBusy || identityOperation.current) return;
    if ((draft.habits ?? []).length > 30 || (draft.habits ?? []).some(habit => habit.length > 300)) { feedback('习惯最多30条，每条最多300字。', true); return; }
    const submitted = structuredClone(draft); savePending.current = true; setSaving(true);
    void request<{ settings: Settings; warning?: string }>('/settings', 'PUT', submitted, undefined, identityDraftRevision.current === undefined ? undefined : { 'x-zeta-identity-revision': String(identityDraftRevision.current) }).then(async result => {
      setDraft(current => current && JSON.stringify(current) !== JSON.stringify(submitted) ? current : structuredClone(result.settings));
      setState(current => current ? { ...current, settings: result.settings } : current);
      feedback(result.warning ? `设置已保存。${result.warning}` : '设置已保存，下次操作会使用新设置。'); await refreshState();
    }).catch(error => feedback(message(error), true)).finally(() => { savePending.current = false; setSaving(false); });
  };
  if (loading) return h('section', { className: 'zeta-settings', 'aria-label': `${PLUGIN_NAME}设置` }, h('p', { className: 'zs-loading', role: 'status' }, `正在读取 ${PLUGIN_NAME}…`));
  if (!state || !draft) return h('section', { className: 'zeta-settings zs-stack', 'aria-label': `${PLUGIN_NAME}设置` }, h('p', { role: 'alert' }, notice?.text || '暂时无法读取设置。'), h(Button, { onClick: () => { setLoading(true); void refreshState().catch(error => feedback(message(error), true)).finally(() => setLoading(false)); } }, '重新连接'));
  const editor = { draft, setDraft, save, saving: saving || identityBusy, dirty };
  let content: ReactNode;
  if (tab === 'overview') content = h(Overview, { state, onNavigate: setTab });
  else if (tab === 'persona') content = h(PersonaPanel, { ...editor, feedback, identity: state.identity ?? { revision: 0, history: [] }, identityBusy, identityOutdated: state.identity?.revision !== identityDraftRevision.current, refreshIdentity: () => identityAction(false), resetIdentity: () => identityAction(true) });
  else if (tab === 'conversations') content = h(ConversationsPanel, { ...editor, state, feedback, refreshState });
  else if (tab === 'memory') content = h(MemoryPanel, { ...editor, feedback });
  else if (tab === 'memes') content = h(MemePanel, { feedback });
  else if (tab === 'speech') content = h(SpeechPanel, { ...editor, feedback, state, refreshState });
  else if (tab === 'security') content = h(SecurityPanel, { ...editor, state, feedback, refreshState });
  else if (tab === 'services') content = h(ServicesPanel, { ...editor, state, feedback, refreshState });
  else if (tab === 'backup') content = h(BackupPanel, { feedback, onRestoreBusy: setRestoreBusy });
  else content = h(LifePanel, { ...editor, state, feedback, refreshState });
  return h('section', { className: 'zeta-settings', 'aria-label': `${PLUGIN_NAME}设置` },
    h('div', { className: 'zs-head' }, h('div', null, h('h2', null, PLUGIN_NAME), h('p', { className: 'zs-muted' }, '一起聊天，也有自己的生活')), h('div', { className: 'zs-actions' }, dirty ? h(Button, { disabled: saving || restoreBusy || identityBusy, onClick: () => { setDraft(structuredClone(state.settings)); identityDraftRevision.current = state.identity?.revision; feedback('已恢复为上次保存的设置。'); } }, '放弃未保存修改') : null, h(Button, { disabled: saving || restoreBusy || identityBusy, onClick: () => { void refreshState().then(() => feedback('状态已刷新，未保存的修改会保留。')).catch(error => feedback(message(error), true)); } }, '刷新'))),
    notice ? h('div', { className: `zs-notice${notice.error ? ' zs-error' : ''}`, role: notice.error ? 'alert' : 'status', 'aria-live': 'polite' }, notice.text) : null,
    h('div', { className: 'zs-tabs', role: 'tablist', 'aria-label': `${PLUGIN_NAME}功能` }, TABS.map((item, index) => h('button', {
      key: item.id, id: `${tabPrefix}-${item.id}-tab`, type: 'button', role: 'tab', className: 'zs-tab', disabled: restoreBusy, tabIndex: tab === item.id ? 0 : -1, 'aria-selected': tab === item.id, 'aria-controls': `${tabPrefix}-panel`, onClick: () => setTab(item.id),
      onKeyDown: (event: { key: string; preventDefault(): void; currentTarget: HTMLButtonElement }) => {
        if (restoreBusy) return;
        const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length : event.key === 'ArrowLeft' ? (index + TABS.length - 1) % TABS.length : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : -1;
        if (next < 0) return; event.preventDefault(); const selected = TABS[next]!; setTab(selected.id); document.getElementById(`${tabPrefix}-${selected.id}-tab`)?.focus();
      },
    }, item.label))),
    h('div', { id: `${tabPrefix}-panel`, role: 'tabpanel', 'aria-labelledby': `${tabPrefix}-${tab}-tab` }, content),
    h('p', { className: 'zs-muted zs-small', style: { marginTop: 20 } }, `${PLUGIN_NAME} ${state.version}`),
  );
}
