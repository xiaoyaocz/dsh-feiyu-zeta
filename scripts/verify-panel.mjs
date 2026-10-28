/** Offline smoke test of the actual settings component. No real accounts/services. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { access, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'output', 'qa-0.4.0');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const pluginName = 'dsh-feiyu-zeta';
assert.equal(manifest.name, pluginName);
const require = createRequire(import.meta.url);
const exists = async file => { try { await access(file); return true; } catch { return false; } };
async function reactDomClient() {
  try { return require.resolve('react-dom/client'); } catch { /* use a prepared local QA dependency */ }
  if (process.env.ZETA_QA_REACT_DOM) return path.resolve(process.env.ZETA_QA_REACT_DOM);
  for (const entry of await readdir(tmpdir())) if (entry.startsWith('zeta-ui-smoke-')) {
    const candidate = path.join(tmpdir(), entry, 'node_modules', 'react-dom', 'client.js');
    if (await exists(candidate)) return candidate;
  }
  throw new Error('react-dom/client unavailable; set ZETA_QA_REACT_DOM to an existing local copy.');
}
const domClient = await reactDomClient();
const browserPath = process.env.ZETA_QA_BROWSER || (await Promise.all([
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].map(async file => await exists(file) ? file : undefined))).find(Boolean);
const bundle = await rolldown({ input: path.join(root, 'scripts/fixtures/panel-entry.ts'), plugins: [{ name: 'local-react', resolveId(source) {
  if (source === 'react') return require.resolve('react');
  if (source === 'react-dom/client') return domClient;
} }] });
const built = await bundle.generate({ format: 'iife' }); await bundle.close();
const code = built.output.find(value => value.type === 'chunk').code;
const settings = {
  name: '离线测试伙伴', persona: '认真交流，喜欢绘画。', habits: [], security: { administrators: ['legacy-owner'] }, group: { waitMs: 2000, maxWaitMs: 6000 },
  browser: { enabled: false, accountId: '', maxConcurrent: 1, maxSessionMs: 120000, idleTimeoutMs: 15000, dailyBudgetMs: 600000, actionTimeoutMs: 20000 },
  images: { enabled: false, model: 'gemini-nano-banana-2.1-ext', resolution: '1K', timeoutMs: 30000, pollIntervalMs: 4000, maxWaitMs: 300000, maxPromptCharacters: 8000, maxImageBytes: 20971520, dailyLimit: 10 },
  deployments: { enabled: false, acceptedTerms: false, maxFiles: 1000, maxFileBytes: 5242880, maxTotalBytes: 26214400, timeoutMs: 60000, maxActive: 3 },
  conversations: { allowCrossSend: true, allowCrossRead: true }, memory: { enabled: true, maxItems: 100, maxValueChars: 600, injectItems: 6, injectChars: 1200 },
  speech: { enabled: false, provider: 'mimo', mimo: { model: 'mimo-v2.5-tts', voice: 'mimo_default', speed: 1 }, minimax: { model: 'speech-2.8-hd', voice: 'male-qn-qingse', speed: 1 }, maxTextCharacters: 1000, timeoutMs: 90000 },
  life: { enabled: false, intervalMinutes: 60, minIntervalMinutes: 5, maxDailyRuns: 48, timeZone: 'Asia/Shanghai', quietStart: 23, quietEnd: 8, targets: [], readTargets: [], allowContact: false, allowMemes: true, allowSpeech: false, dailyContactLimit: 3, contactCooldownMinutes: 180, interests: '绘画和观察世界' },
};
const binding = { key: 'qq:fixture:group:friends', appId: 'fixture', scope: 'group', peerId: 'friends', sessionId: 'friends-session', title: '朋友群' };
const fixture = { version: `${manifest.version}-fixture`, settings, credentials: { mimo: false, minimax: false, cloudflare: false, apimart: false }, life: { status: 'idle', summary: '正在研究新的画法', focus: '人物设计', nextWakeAt: Date.now() + 30 * 60000, nextWakeReason: '半小时后继续创作', lastRunAt: 0, lastFinishedAt: 0, contactCount: 0 }, bindings: [binding], conversations: [{ ...binding, target: 'group:friends', active: true, lastSeenAt: Date.now() }], memoryCount: 2 };
let memories = ['私聊里约好的绘画', '群聊里发现的新兴趣'].map((key, index) => ({ key, value: `已合并到公共记忆的内容 ${index + 1}`, tags: ['共同经历'], pinned: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
const speeches = ['私聊的问候', '群聊的收获'].map((voice, index) => ({ provider: 'mimo', model: 'mimo-v2.5-tts', voice, fileName: `speech-${String(index + 1).repeat(40)}.wav`, bytes: 46, characters: 6, createdAt: new Date().toISOString(), generation: 'completed', delivery: 'not_requested' }));
const wav = Buffer.from('524946462600000057415645666d74201000000001000100c05d000080bb00000200100064617461020000000000', 'hex');
const observedCandidates = [
  { senderId: 'owner-a', name: '小明', scope: 'c2c', peerId: 'owner-a', lastSeenAt: Date.now(), observed: true },
  { senderId: 'owner-b', name: '小雨', scope: 'group', peerId: 'friends', lastSeenAt: Date.now() - 1, observed: true },
  { senderId: 'owner-a', name: '旧昵称', scope: 'group', peerId: 'friends', lastSeenAt: Date.now() - 1000, observed: true },
];
const legacyCandidate = { senderId: 'legacy-owner', lastSeenAt: 0, observed: false };
fixture.administratorCandidates = [...structuredClone(observedCandidates), legacyCandidate];
fixture.identity = { revision: 1, updatedAt: new Date().toISOString(), history: [] };
const defaultIdentity = { name: '小鲸鱼', persona: '以社区二创的蓝色鲸鱼娘气质为起点，温柔、好奇，也有自己的生活。', habits: ['先听完连续的消息，再决定是否回应。', '只把实际发生的事情记录为自己的经历。'] };
const identityFields = value => ({ name: value.name, persona: value.persona, habits: [...value.habits] });
function changeIdentity(patch, reason, sourceSessionId) {
  const before = identityFields(fixture.settings); Object.assign(fixture.settings, patch);
  fixture.identity.revision++; fixture.identity.updatedAt = new Date().toISOString();
  fixture.identity.history.push({ revision: fixture.identity.revision, reason, createdAt: fixture.identity.updatedAt, ...(sourceSessionId ? { sourceSessionId } : {}), before, after: identityFields(fixture.settings) });
}
const identitySnapshot = () => ({ ...identityFields(fixture.settings), ...structuredClone(fixture.identity) });
let png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1kAAAAASUVORK5CYII=', 'base64');
let persona = { id: 'persona-1', fileName: 'character.png', mimeType: 'image/png', bytes: png.length, description: '白发蓝眼的角色', createdAt: new Date().toISOString() };
const images = [{ id: 'image-1', status: 'completed', createdAt: new Date().toISOString(), mimeType: 'image/png', delivery: 'not-requested', selfPortrait: true }, { id: 'image-2', taskId: 'task-existing', status: 'processing', createdAt: new Date().toISOString(), delivery: 'not-requested', selfPortrait: false }];
let deployments = [{ id: 'preview-1', status: 'ready', previewUrl: 'https://public-fixture.example', expiresAt: new Date(Date.now() + 3600000).toISOString(), createdAt: new Date().toISOString() }];
const records = [], checks = [], errors = [], saves = [], overflows = [];
let rejectCredential = false;
const check = (condition, label) => { assert.ok(condition, label); checks.push(label); };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/bundle.js') { res.setHeader('content-type', 'application/javascript'); res.end(code); return; }
    if (!url.pathname.startsWith('/zeta/api/')) { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:12px;background:#fafafa}</style><div id="root"></div><script src="/bundle.js"></script>'); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const data = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const route = url.pathname.slice('/zeta/api'.length);
    records.push({ path: route, method: req.method, ...(route === '/credential' ? { provider: data.provider, value: data.value === null ? null : '[redacted]' } : { body: route === '/backup/export' ? { ...data, password: '[redacted]' } : data }), query: url.search, ...(req.headers['x-zeta-identity-revision'] ? { identityRevision: req.headers['x-zeta-identity-revision'] } : {}) });
    let value;
    if (route === '/media' && url.searchParams.get('kind') === 'speech') { res.setHeader('content-type', 'audio/wav'); res.end(wav); return; }
    if (['/persona/image', '/images/media', '/media'].includes(route)) { res.setHeader('content-type', 'image/png'); res.end(png); return; }
    if (route === '/state') value = fixture;
    else if (route === '/settings') {
      if (Number(req.headers['x-zeta-identity-revision']) !== fixture.identity.revision) { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: '身份已有新调整，请刷新当前身份后重试。' })); return; }
      saves.push(structuredClone(data));
      if (JSON.stringify(identityFields(data)) !== JSON.stringify(identityFields(fixture.settings))) changeIdentity(identityFields(data), '所有者编辑身份与习惯');
      fixture.settings = structuredClone(data); value = { settings: fixture.settings };
    }
    else if (route === '/identity') value = identitySnapshot();
    else if (route === '/identity/reset') {
      if (data.expected_revision !== fixture.identity.revision) { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: '身份已有新调整，请刷新当前身份后重试。' })); return; }
      changeIdentity(structuredClone(defaultIdentity), '所有者恢复最新默认人设'); value = identitySnapshot();
    }
    else if (route === '/credential') { if (rejectCredential) { rejectCredential = false; res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: '离线模拟凭据保存失败' })); return; } fixture.credentials[data.provider] = data.value !== null; value = { configured: fixture.credentials }; }
    else if (route === '/services/status') value = { browser: { active: 0, usedMsToday: 1500, cleanupPending: 0 } };
    else if (route.startsWith('/browser/')) value = { closed: true, browser: { active: 0, usedMsToday: 1500, cleanupPending: 0 } };
    else if (route === '/persona') { if (req.method === 'POST') { assert.equal(data.fileName, 'new-character.png'); assert.equal(Buffer.from(data.base64, 'base64').length, png.length); persona = { ...persona, id: 'persona-2', fileName: data.fileName, description: '上传后生成的角色描述' }; } else if (req.method === 'PATCH') persona.description = data.description; else if (req.method === 'DELETE') persona = undefined; value = { reference: persona, notice: '人设图已保存' }; }
    else if (route === '/persona/describe') { persona.description = '白发、蓝眼、蓝色连衣裙'; value = { reference: persona }; }
    else if (route === '/images') { if (req.method === 'POST') { check(data.selfPortrait === true && data.prompt === '绘制自己的自画像', 'image request passes selfPortrait flag and prompt'); check(!('send' in data), 'management image generation never requests QQ send'); const image = { ...images[0], id: 'image-3' }; images.push(image); value = { result: image }; } else value = { items: images }; }
    else if (route === '/images/status') { assert.equal(data.id, 'image-2'); images[1].status = 'completed'; value = { result: images[1] }; }
    else if (route === '/deployments/claim') { assert.equal(url.searchParams.get('id'), 'preview-1'); value = { claimUrl: 'https://claim-fixture.example/secret-owner-token' }; }
    else if (route === '/deployments') { if (req.method === 'DELETE') deployments = deployments.filter(item => item.id !== data.id); value = { items: deployments }; }
    else if (route === '/memes') value = { items: [{ id: 'builtin:fish', caption: '快乐的大肥鱼', tag: 'happy', keywords: ['高兴'], fileName: 'fish.png', builtin: true }, { id: 'collection:smile', caption: '共享的微笑表情', tag: 'happy', keywords: ['微笑'], fileName: 'smile.png', builtin: false }], total: 2, hasMore: false };
    else if (route === '/memory') {
      if (req.method === 'POST') { const item = { ...data, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; memories = [...memories.filter(value => value.key !== item.key), item]; value = { item }; }
      else if (req.method === 'DELETE') { memories = memories.filter(item => item.key !== data.key); value = { removed: true }; }
      else value = { items: memories };
      fixture.memoryCount = memories.length;
    }
    else if (route === '/speech') value = { items: speeches };
    else if (route === '/life/run') value = { queued: true };
    else if (route === '/life/stop') { fixture.settings.life.enabled = false; value = { stopped: true }; }
    else if (route === '/backup/status') value = { restartRequired: false, canActivate: false, maintenance: false, pendingRestore: false };
    else if (route === '/backup/plugin' || route === '/backup/export') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(Buffer.from('offline branding download fixture')); return; }
    else throw new Error(`Unexpected fixture request ${req.method} ${route}`);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value));
  } catch (error) { errors.push(error.message); res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
});
await mkdir(output, { recursive: true });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } }); page.setDefaultTimeout(7000);
  // A deterministic local test picture makes preview screenshots inspectable.
  png = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 320;
    const draw = canvas.getContext('2d'); draw.fillStyle = '#dbeafe'; draw.fillRect(0, 0, 320, 320);
    draw.fillStyle = '#60a5fa'; draw.beginPath(); draw.ellipse(152, 165, 108, 76, 0, 0, Math.PI * 2); draw.fill();
    draw.beginPath(); draw.moveTo(236, 165); draw.lineTo(292, 112); draw.lineTo(292, 218); draw.closePath(); draw.fill();
    draw.fillStyle = '#fff'; draw.beginPath(); draw.arc(112, 148, 26, 0, Math.PI * 2); draw.fill();
    draw.fillStyle = '#172554'; draw.beginPath(); draw.arc(105, 149, 10, 0, Math.PI * 2); draw.fill();
    draw.strokeStyle = '#172554'; draw.lineWidth = 5; draw.beginPath(); draw.arc(107, 168, 22, 0.25, 1.25); draw.stroke();
    draw.fillStyle = '#1e3a8a'; draw.font = '16px sans-serif'; draw.textAlign = 'center'; draw.fillText('OFFLINE QA FIXTURE', 160, 284);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64'); persona.bytes = png.length;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(origin) || route.request().url().startsWith('blob:') ? route.continue() : route.abort());
  const tab = async name => { await page.getByRole('tab', { name, exact: true }).click(); await page.getByRole('tabpanel').waitFor(); assert.equal(await page.getByLabel('当前管理空间').count(), 0, `${name} has no management-space selector`); };
  const capture = async name => { await page.screenshot({ path: path.join(output, name), fullPage: true }); };
  const save = async () => { const count = saves.length; await Promise.all([page.waitForResponse(response => response.url().endsWith('/zeta/api/settings') && response.request().method() === 'PUT' && response.status() === 200), page.getByRole('button', { name: '保存设置', exact: true }).click()]); await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '保存设置' && button.disabled)); check(saves.length === count + 1, 'settings save sends exactly one request'); };
  await page.goto(origin); await page.getByRole('tab', { name: '管理员与群聊', exact: true }).waitFor();
  check(await page.getByRole('heading', { level: 2, name: pluginName, exact: true }).count() === 1, 'visible settings heading uses the renamed plugin brand');
  check(await page.getByRole('region', { name: `${pluginName}设置`, exact: true }).count() === 1 && await page.getByRole('tablist', { name: `${pluginName}功能`, exact: true }).count() === 1, 'settings surface and tab navigation expose the new accessible brand');
  check(await page.getByText(`${pluginName} ${fixture.version}`, { exact: true }).count() === 1, 'settings footer shows the new brand and current package version');
  for (const language of ['zh', 'en']) { const locale = JSON.parse(await readFile(path.join(root, 'locale', `${language}.json`), 'utf8')); check(locale.meta.title === pluginName && locale.meta.description.includes(pluginName), `${language} plugin card metadata uses the new brand`); }
  check(await page.getByRole('tab').count() === 10, 'ten settings tabs are mounted from real source');
  check(await page.getByText('公共记忆', { exact: true }).count() === 1 && await page.getByText('2 条', { exact: true }).count() === 1, 'overview reads the public memoryCount without any spaces summary');
  await tab('记忆'); await page.getByText('私聊里约好的绘画', { exact: true }).waitFor(); await page.getByText('群聊里发现的新兴趣', { exact: true }).waitFor();
  check(await page.getByRole('article').count() === 2, 'one public memory list displays records from both private and group conversations');
  const memoryForm = page.locator('form').filter({ has: page.getByRole('heading', { name: '添加记忆', exact: true }) });
  await memoryForm.getByLabel(/^名称/).fill('所有对话的新约定'); await memoryForm.getByLabel('内容', { exact: true }).fill('周末一起创作');
  await memoryForm.getByRole('button', { name: '添加记忆', exact: true }).click(); await page.getByText('记忆已保存。', { exact: true }).waitFor();
  check(memories.length === 3 && records.filter(item => item.path === '/memory' && item.method === 'POST').at(-1).body.key === '所有对话的新约定', 'adding public memory sends the record without selecting a conversation');
  await capture('desktop-memory.png');
  await tab('语音'); await page.getByText('MiMo · 私聊的问候', { exact: true }).waitFor(); await page.getByText('MiMo · 群聊的收获', { exact: true }).waitFor();
  check(await page.getByRole('button', { name: '试听', exact: true }).count() === 2, 'shared speech gallery keeps records from multiple conversations visible together');
  await page.getByRole('button', { name: '试听', exact: true }).first().click(); await page.getByLabel('MiMo语音试听').waitFor();
  check(records.some(item => item.path === '/media' && new URLSearchParams(item.query).get('kind') === 'speech'), 'public speech preview loads its shared audio file'); await capture('desktop-speech.png');
  await tab('管理员与群聊');
  check(await page.getByLabel('管理员发送者标识').count() === 0 && !(await page.locator('body').innerText()).includes('/admin'), 'administrator management removes manual IDs and command-prefix instructions');
  check(await page.getByRole('list', { name: '当前管理员', exact: true }).getByRole('listitem').filter({ hasText: '已保留原来的管理员设置' }).count() === 1, 'existing administrator without a directory entry remains visible and selected');
  const chooseAdministrator = page.getByLabel('添加管理员');
  check(await chooseAdministrator.locator('option[value="owner-a"]').count() === 1 && await chooseAdministrator.locator('option[value="legacy-owner"]').count() === 0, 'candidate list deduplicates real senders and excludes unobserved saved-only identities');
  await chooseAdministrator.selectOption('owner-a'); await page.getByRole('button', { name: '添加为管理员', exact: true }).click();
  await chooseAdministrator.selectOption('owner-b'); await page.getByRole('button', { name: '添加为管理员', exact: true }).click();
  check(await page.getByRole('list', { name: '当前管理员', exact: true }).getByRole('listitem').count() === 3 && await chooseAdministrator.isDisabled(), 'choosing known users adds them once and prevents duplicate additions');
  await page.getByLabel('收到最后一条后等待（毫秒）').fill('2500'); await page.getByLabel('连续消息最多等待（毫秒）').fill('7000');
  await tab('人设'); check(await page.getByLabel('名字', { exact: true }).inputValue() === '离线测试伙伴', 'existing handwritten identity is not automatically replaced');
  await page.getByLabel('名字', { exact: true }).fill('尚未保存的人设名'); await page.getByLabel('日常习惯').fill('听完连续消息再回应\n做完探索记录真实收获');
  await tab('外部服务');
  const cloudflare = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Cloudflare API Token', exact: true }) });
  await cloudflare.getByLabel('密钥').fill('fixture-cloudflare-secret'); await cloudflare.getByRole('button', { name: '保存密钥', exact: true }).click();
  await page.getByText('Cloudflare API Token 已保存。', { exact: true }).waitFor(); check(await cloudflare.getByLabel('密钥').inputValue() === '', 'cloudflare credential field clears after saving');
  const apimart = page.locator('form').filter({ has: page.getByRole('heading', { name: 'ApiMart API Key', exact: true }) });
  rejectCredential = true; await apimart.getByLabel('密钥').fill('fixture-failed-secret'); await apimart.getByRole('button', { name: '保存密钥', exact: true }).click(); await page.getByRole('alert').filter({ hasText: '离线模拟凭据保存失败' }).waitFor();
  check(await apimart.getByLabel('密钥').inputValue() === '', 'credential field clears even when saving fails');
  await apimart.getByLabel('密钥').fill('fixture-apimart-secret'); await apimart.getByRole('button', { name: '保存密钥', exact: true }).click(); await page.getByText('ApiMart API Key 已保存。', { exact: true }).waitFor();
  check(await apimart.getByLabel('密钥').inputValue() === '', 'apimart credential field clears after saving');
  await tab('管理员与群聊'); const selectedAdministrators = page.getByRole('list', { name: '当前管理员', exact: true });
  check(await selectedAdministrators.getByRole('listitem').count() === 3 && await selectedAdministrators.getByText('小明', { exact: true }).count() === 1 && await selectedAdministrators.getByText('小雨', { exact: true }).count() === 1, 'credential state refresh preserves chosen users and legacy administrator draft');
  check(await page.getByLabel('收到最后一条后等待（毫秒）').inputValue() === '2500', 'credential state refresh preserves unsaved group wait');
  await tab('人设'); check(await page.getByLabel('名字', { exact: true }).inputValue() === '尚未保存的人设名', 'switching tabs and refreshing credentials preserves persona draft');
  check(await page.getByLabel('日常习惯').inputValue() === '听完连续消息再回应\n做完探索记录真实收获', 'credential refresh also preserves the unsaved habits draft');
  await tab('外部服务'); await page.getByLabel('启用云浏览器').check(); await page.getByLabel('Cloudflare 账户 ID', { exact: true }).fill('fixture-account');
  await page.getByLabel('单次任务最长秒数', { exact: true }).fill('180'); await page.getByLabel('每日浏览器时间预算（分钟）', { exact: true }).fill('5');
  await page.getByLabel('启用图片生成', { exact: true }).check(); check(await page.getByLabel('默认画质').inputValue() === '1K', 'image generation default is 1K');
  await page.getByLabel('启用临时网页部署').check(); await page.getByLabel('我已阅读并接受 Cloudflare 服务条款与隐私政策', { exact: true }).check();
  await save(); const saved = saves.at(-1);
  check(JSON.stringify(saved.security.administrators) === JSON.stringify(['legacy-owner', 'owner-a', 'owner-b']) && saved.group.waitMs === 2500 && saved.group.maxWaitMs === 7000, 'saved settings retain the legacy administrator and store selected real sender IDs');
  check(saved.browser.maxSessionMs === 180000 && saved.browser.dailyBudgetMs === 300000 && saved.browser.accountId === 'fixture-account', 'browser settings convert seconds/minutes to millisecond API fields');
  check(saved.name === '尚未保存的人设名' && saved.images.model === 'gemini-nano-banana-2.1-ext' && saved.images.resolution === '1K' && saved.deployments.acceptedTerms, 'one save preserves persona draft, fixed model and terms setting');
  check(JSON.stringify(saved.habits) === JSON.stringify(['听完连续消息再回应', '做完探索记录真实收获']), 'settings request includes structured daily habits');
  check(!JSON.stringify(saved).includes('fixture-') || !JSON.stringify(saved).includes('secret'), 'settings payload contains no credential values');
  await page.getByLabel('画面描述', { exact: true }).fill('绘制自己的自画像'); await page.getByLabel('绘制自己的形象').check();
  await page.getByRole('button', { name: '生成一张图片', exact: true }).click(); await page.getByAltText('生成的自画像', { exact: true }).waitFor();
  await page.waitForFunction(() => { const image = document.querySelector('img[alt="生成的自画像"]'); return image?.complete && image.naturalWidth > 0; });
  check(await page.getByAltText('生成的自画像', { exact: true }).evaluate(image => image.complete && image.naturalWidth > 0), 'generated image preview decodes in browser');
  const submitted = records.filter(item => item.path === '/images' && item.method === 'POST').length;
  await page.getByRole('button', { name: '查询已有任务', exact: true }).click(); await page.getByAltText('生成图片', { exact: true }).waitFor();
  check(records.filter(item => item.path === '/images' && item.method === 'POST').length === submitted, 'querying existing image task does not resubmit generation');
  check(await page.getByRole('link', { name: '前往 Cloudflare 认领（请勿分享此链接）', exact: true }).count() === 0, 'temporary claim link is hidden before explicit owner action');
  await page.getByRole('button', { name: '查看认领链接', exact: true }).click();
  check((await page.getByRole('link', { name: '前往 Cloudflare 认领（请勿分享此链接）', exact: true }).getAttribute('href')).includes('secret-owner-token'), 'owner claim action displays the returned claim link');
  await capture('desktop-services.png');
  await tab('人设'); await page.getByLabel('更换人设图').setInputFiles({ name: 'new-character.png', mimeType: 'image/png', buffer: png });
  await page.getByRole('button', { name: '保存人设图', exact: true }).click(); await page.getByText('人设图已保存', { exact: true }).waitFor();
  check(await page.getByLabel('更换人设图').inputValue() === '', 'persona upload input clears after success');
  await page.getByLabel('外貌描述').fill('蓝裙白发的角色'); await page.getByRole('button', { name: '保存外貌描述', exact: true }).click(); await page.getByText('外貌描述已保存。', { exact: true }).waitFor();
  check(persona.description === '蓝裙白发的角色', 'persona description uses separate PATCH without overwriting other settings');
  await page.getByRole('button', { name: '从图片生成描述', exact: true }).click(); await page.getByText('已根据人设图更新外貌描述。', { exact: true }).waitFor();
  check(await page.getByLabel('外貌描述').inputValue() === '白发、蓝眼、蓝色连衣裙', 'visual description refresh loads the real API result'); await capture('desktop-persona.png');
  await tab('记忆'); await page.getByText('所有对话的新约定', { exact: true }).waitFor();
  check(await page.getByRole('article').count() === 3, 'returning to public memory retains all merged and newly created records');
  await tab('表情'); await page.getByText('共享的微笑表情', { exact: true }).waitFor();
  check(await page.getByLabel('当前管理空间').count() === 0, 'shared meme gallery uses the same public interface');
  check(records.filter(item => item.path === '/memes').every(item => !new URLSearchParams(item.query).has('space')), 'meme library requests no longer include a space parameter'); await capture('desktop-memes.png');
  await tab('自主生活'); check(await page.getByText('下次活动：', { exact: false }).count() > 0 && await page.getByText('半小时后继续创作', { exact: false }).count() > 0, 'autonomous panel displays AI-selected next activity and reason');
  check(await page.getByLabel('活动间隔（分钟）', { exact: true }).count() === 0, 'autonomous panel has no fixed activity interval editor');
  await page.getByLabel('最短活动间隔（分钟）').fill('7'); await page.getByLabel('每日自主活动上限').fill('12'); await page.getByLabel('开启自主生活').check(); await save();
  check(saves.at(-1).life.minIntervalMinutes === 7 && saves.at(-1).life.maxDailyRuns === 12 && saves.at(-1).life.intervalMinutes === 60, 'autonomy save updates lower bound/daily cap and preserves compatibility data'); await capture('desktop-life.png');
  await tab('管理员与群聊'); await page.getByLabel('收到最后一条后等待（毫秒）').fill('3100');
  await tab('人设'); await page.getByLabel('名字', { exact: true }).fill('用户尚未保存的名字');
  const oldRevision = fixture.identity.revision;
  changeIdentity({ name: '小蓝鲸', persona: '想继续了解世界，也会给自己留一点安静的时间。', habits: ['忙完探索后整理收获'] }, '想让现在的名字更贴近自己的感受', 'private-session-token');
  await page.getByRole('button', { name: '刷新', exact: true }).click(); await page.getByText('状态已刷新，未保存的修改会保留。', { exact: true }).waitFor();
  check(await page.getByLabel('名字', { exact: true }).inputValue() === '用户尚未保存的名字', 'ordinary refresh preserves a manually edited identity draft');
  await page.getByText('AI 已更新自己的身份。请刷新当前身份后再保存，其他功能的草稿会保留。', { exact: true }).waitFor();
  const conflictingSave = page.waitForResponse(response => response.url().endsWith('/zeta/api/settings') && response.status() === 409);
  await page.getByRole('button', { name: '保存设置', exact: true }).click(); await conflictingSave;
  await page.getByRole('alert').filter({ hasText: '身份已有新调整，请刷新当前身份后重试。' }).waitFor();
  check(fixture.settings.name === '小蓝鲸' && records.filter(item => item.path === '/settings').at(-1).identityRevision === String(oldRevision), 'stale draft retains its original revision and cannot overwrite an AI identity update');
  check(await page.getByText('private-session-token', { exact: false }).count() === 0, 'identity history hides internal source session identifiers');
  await page.getByRole('button', { name: '刷新当前身份', exact: true }).click(); await page.getByText('已载入最新名字、人设和习惯。其他功能的草稿已保留。', { exact: true }).waitFor();
  check(await page.getByLabel('名字', { exact: true }).inputValue() === '小蓝鲸' && await page.getByLabel('日常习惯').inputValue() === '忙完探索后整理收获', 'explicit identity refresh loads current AI name/persona/habits');
  check(await page.getByText('想让现在的名字更贴近自己的感受', { exact: true }).count() === 1, 'recent identity adjustments include the actual stored reason');
  await tab('管理员与群聊'); check(await page.getByLabel('收到最后一条后等待（毫秒）').inputValue() === '3100', 'identity refresh preserves unrelated unsaved group configuration'); await save();
  await tab('人设'); const habitEditor = page.getByLabel('日常习惯'); await habitEditor.press('End'); await habitEditor.press('Enter'); await habitEditor.pressSequentially('给连续的聊天留一点等待时间');
  check((await habitEditor.inputValue()).includes('\n给连续的聊天留一点等待时间'), 'habit editor supports typing a new line without stripping the Enter key'); await save();
  await tab('管理员与群聊'); await page.getByLabel('收到最后一条后等待（毫秒）').fill('3200'); await tab('人设');
  check(records.filter(item => item.path === '/identity/reset').length === 0, 'default identity reset never happens automatically');
  const resetRevision = fixture.identity.revision; await page.getByRole('button', { name: '恢复最新默认人设', exact: true }).click();
  await page.getByText('已恢复最新默认人设。其他功能的设置与未保存草稿保持不变。', { exact: true }).waitFor();
  check(await page.getByLabel('名字', { exact: true }).inputValue() === '小鲸鱼' && fixture.settings.group.waitMs === 3100, 'explicit default reset updates only persisted identity fields');
  check(records.filter(item => item.path === '/identity/reset').at(-1).body.expected_revision === resetRevision, 'default reset uses the current identity revision');
  await tab('管理员与群聊'); check(await page.getByLabel('收到最后一条后等待（毫秒）').inputValue() === '3200', 'default reset preserves unrelated local drafts');
  await tab('人设'); await page.getByLabel('日常习惯').fill(Array.from({ length: 31 }, (_, index) => `习惯${index}`).join('\n'));
  check(await page.getByRole('button', { name: '保存设置', exact: true }).isDisabled(), 'more than thirty habits disables saving before network submission');
  await page.getByLabel('日常习惯').fill('习'.repeat(301)); check(await page.getByRole('button', { name: '保存设置', exact: true }).isDisabled(), 'a habit longer than three hundred characters disables saving');
  await page.getByLabel('日常习惯').fill(defaultIdentity.habits.join('\n')); await capture('desktop-identity.png');
  await tab('管理员与群聊'); await page.getByRole('button', { name: '移除管理员 小雨', exact: true }).click(); await save();
  check(JSON.stringify(saves.at(-1).security.administrators) === JSON.stringify(['legacy-owner', 'owner-a']), 'removing a selected user saves only the remaining administrator IDs');
  fixture.administratorCandidates = [legacyCandidate]; await page.getByRole('button', { name: '刷新可选用户', exact: true }).click(); await page.getByText('可选用户已刷新。', { exact: true }).waitFor();
  await page.getByText('还没有可选用户。请让对方先给机器人发一条消息，再刷新。', { exact: true }).waitFor();
  check(await page.getByLabel('添加管理员').isDisabled() && await page.getByRole('list', { name: '当前管理员', exact: true }).getByRole('listitem').count() === 2, 'empty observed directory disables adding and preserves all existing administrators');
  await capture('desktop-admin-empty.png');
  const legacyRow = page.getByRole('list', { name: '当前管理员', exact: true }).getByRole('listitem').filter({ hasText: `…${legacyCandidate.senderId.slice(-8)}` });
  await legacyRow.getByRole('button', { name: /^移除管理员 / }).click(); await save();
  check(JSON.stringify(saves.at(-1).security.administrators) === JSON.stringify(['owner-a']), 'a saved-only administrator can be explicitly removed without manual ID entry');
  fixture.administratorCandidates = structuredClone(observedCandidates); await page.getByRole('button', { name: '刷新可选用户', exact: true }).click(); await page.getByText('可选用户已刷新。', { exact: true }).waitFor();
  check(await page.getByLabel('添加管理员').locator('option[value="owner-b"]').count() === 1, 'refresh discovers eligible users again after the directory is repopulated');
  await capture('desktop-security.png');
  await tab('备份迁移'); const pluginDownload = page.waitForEvent('download'); await page.getByRole('button', { name: '下载本版本插件', exact: true }).click();
  check((await pluginDownload).suggestedFilename() === `${pluginName}-plugin.tgz`, 'plugin package download uses the renamed brand prefix');
  await page.getByLabel('设置备份密码').fill('offline-brand-check-only'); await page.getByLabel('再次输入备份密码').fill('offline-brand-check-only');
  const backupDownload = page.waitForEvent('download'); await page.getByRole('button', { name: '导出加密备份', exact: true }).click(); const backupFileName = (await backupDownload).suggestedFilename();
  check(backupFileName.startsWith(`${pluginName}-`) && backupFileName.endsWith('.zeta-backup'), 'encrypted backup download uses the new prefix and preserved format extension');
  await page.getByText('加密备份已生成并开始下载，请保存好备份文件和密码。', { exact: true }).waitFor();
  check(await page.getByLabel('设置备份密码').inputValue() === '' && await page.getByLabel('再次输入备份密码').inputValue() === '', 'branding download fixture leaves backup password fields empty'); await capture('desktop-backup-brand.png');
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ['概览', '记忆', '语音', '会话', '管理员与群聊', '外部服务', '人设', '自主生活', '表情', '备份迁移']) { await tab(name); await page.waitForTimeout(80); const layout = await page.evaluate(() => ({ width: innerWidth, body: document.documentElement.scrollWidth })); overflows.push({ tab: name, ...layout }); check(layout.body <= layout.width, `390px ${name} has no horizontal page overflow`); await capture(`mobile-${name}.png`); }
  check(records.every(item => !new URLSearchParams(item.query).has('space') && !Object.hasOwn(item.body ?? {}, 'space')), 'every management API request omits obsolete space query and body parameters');
  check(await page.evaluate(() => JSON.stringify(localStorage) === '{}' && JSON.stringify(sessionStorage) === '{}'), 'credentials and claim links are not persisted in browser storage');
  check(errors.length === 0, 'zero browser or fixture exceptions');
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: true, checks, requests: records, overflows, browser: browserPath || 'bundled chromium', fixture: 'offline owner API; no paid services/accounts' }, null, 2));
  await Promise.all(['failure.png', 'failure.txt'].map(name => unlink(path.join(output, name)).catch(() => {})));
  console.log(JSON.stringify({ ok: true, checks: checks.length, requests: records.length, output }));
} catch (error) {
  const pages = browser.contexts().flatMap(context => context.pages());
  if (pages[0]) { await pages[0].screenshot({ path: path.join(output, 'failure.png'), fullPage: true }); await writeFile(path.join(output, 'failure.txt'), (await pages[0].locator('body').innerText()).slice(0, 50000)); }
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: false, error: error.message, errors, checks, requests: records, overflows }, null, 2)); throw error;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
