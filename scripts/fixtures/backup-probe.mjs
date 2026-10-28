// Test-only real-Host migration probe. It never opens the user's DSH home.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

export const name = 'zeta-backup-host-fixture';
// Deliberately do not inject projectZeta or schedule: ConfigEditor reloads
// both during restore. Each request resolves their current services instead.
export const inject = ['llm', 'agents', 'agentPresets', 'tools', 'sessions', 'sessionPersistence', 'sessionController', 'attachments', 'credentials', 'connection', 'webServer', 'configEditor'];
const APP_ID = 'zeta-portable-fixture';
const QQ_SECRET = 'fixture-qq-secret-no-live-account';
const MIMO = 'fixture-mimo-secret-no-provider-request';
const MINIMAX = 'fixture-minimax-secret-no-provider-request';
const MEMORY = 'Local fixture memory survives complete computer migration';
const PROGRESS = 'Local migration fixture completed a real native life turn';
const NEXT_PLAN = 'Local migration fixture will continue tomorrow';
const IDENTITY_NAME = '迁移小鲸鱼';
const IDENTITY_PERSONA = '认真保存真实经历，喜欢探索，也愿意慢慢听人说话。';
const QQ_HABIT = 'migration-fixture-keep-real-experiences';
const LIFE_HABIT = 'migration-fixture-reflect-before-sharing';
const QQ_IDENTITY_REASON = 'Ordinary QQ chose a portable native identity';
const LIFE_IDENTITY_REASON = 'Autonomous life evolved a portable native habit';
const WAVE = Buffer.from('524946462400000057415645666d74201000000001000100805d000000bb0000020010006461746100000000', 'hex');
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = value => createHash('sha256').update(value).digest('hex');
function png() {
  const chunk = (type, data) => {
    const text = Buffer.from(type); const payload = Buffer.concat([text, data]); let crc = 0xffffffff;
    for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); payload.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255, 0, 0, 255, 255]))), chunk('IEND', Buffer.alloc(0))]);
}

export async function apply(ctx, config) {
  const native = async name => import(pathToFileURL(join(config.moduleRoot, name, 'lib/index.js')).href);
  const { LlmAdapter, createUserMessage } = await native('dsh-llm');
  const { appendPluginRecord } = await native('dsh-session');
  const { credentialRef } = await native('dsh-credentials');
  const local = path => import(pathToFileURL(join(config.pluginRoot, 'dist', path)).href);
  const { SessionManager } = await local('session/session-manager.js');
  const { ConfigSchema } = await local('config.js');
  const { PrefsStore } = await local('model/prefs-store.js');
  const { getHistoryStore, historyGroupKey } = await local('features/history-store.js');
  const { BackupService } = await local('zeta/backup.js');
  const configTypes = value => Object.fromEntries(Object.entries(value || {}).map(([key, member]) => [key, member === null ? 'null' : `${typeof member}${typeof member === 'object' ? `:${Object.getPrototypeOf(member)?.constructor?.name || 'null'}` : ''}`]));
  // Test-only instrumentation keeps the public endpoint's deliberately terse
  // error response, while making fake-data failures diagnosable in this home.
  const observations = ['exportBundle', 'preview', 'restore'].map(method => {
    const original = BackupService.prototype[method];
    async function observed(...args) {
      try { return await original.apply(this, args); }
      catch (error) {
        const rows = ctx.configEditor.configuration().filter(row => row.entry.options.name === '@deepseek-ai/dsh-agent-default-model').map(row => ({ id: row.entry.options.id, effectiveTypes: configTypes(row.entry.fiber?.config), inheritedTypes: configTypes(row.inherited), overrideTypes: configTypes(row.override) }));
        await writeFile(join(config.home, `fixture-${method}-error.txt`), `${error?.stack || error}\n${JSON.stringify(rows)}`, 'utf8'); throw error;
      }
    }
    BackupService.prototype[method] = observed;
    return { method, original, observed };
  });
  const runtime = () => { const value = ctx.get('projectZeta'); if (!value) throw new Error('ProjectZeta is still loading'); return value; };
  const schedule = () => { const value = ctx.get('schedule'); if (!value) throw new Error('Native Schedule is still loading'); return value; };
  const checks = [];
  let modelCalls = 0; let fakeSends = 0; let fakeTtsCalls = 0; let fakeStarts = 0; let manager; let seeded;
  let failNextQQCommit = false; let failedQQCommits = 0;
  const editor = ctx.configEditor; const edit = editor.edit;
  async function observedEdit(entry, change) {
    if (failNextQQCommit && entry.options.id === 'im-qqbot') { failNextQQCommit = false; failedQQCommits++; throw new Error('Controlled local fixture interruption at the final QQ configuration commit'); }
    return edit.call(this, entry, change);
  }
  editor.edit = observedEdit;
  // Patch the exact installed SDK class used by bootstrapGateway, before any
  // explicit activation. Constructors stay real; transport start is local.
  const sdkPath = join(await realpath(config.pluginRoot), '..', '@tencent-connect/qqbot-nodejs/dist/index.js');
  const { QQBot } = await import(pathToFileURL(sdkPath).href);
  const sdkMethods = ['start', 'stop', 'sendMarkdown', 'sendText', 'sendMessage', 'sendImage', 'sendVoice', 'sendVideo', 'sendFile', 'openStream'].map(method => {
    const original = QQBot.prototype[method];
    const observed = method === 'start' ? async function () { fakeStarts++; assert.equal(config.machine, 'target'); }
      : method === 'stop' ? function () {} : function () { fakeSends++; throw new Error('No real QQ delivery is available in this fixture'); };
    QQBot.prototype[method] = observed;
    return { method, original, observed };
  });
  const check = (condition, message) => { assert.ok(condition, message); checks.push(message); };
  function latestIdentityResult(messages) {
    for (const message of [...messages].reverse()) {
      if (message.role !== 'tool') continue;
      for (const block of message.content || []) {
        if (block.type !== 'text') continue;
        try { const value = JSON.parse(block.text); if (typeof value.name === 'string' && typeof value.persona === 'string' && Array.isArray(value.habits) && Number.isInteger(value.revision)) return value; } catch { /* Not an identity tool result. */ }
      }
    }
  }
  class FixtureModel extends LlmAdapter {
    async listModels(provider) { return ['fixture', 'fixture-2'].map(id => ({ provider, id, name: `Local migration ${id}`, inputModalities: ['text', 'image'] })); }
    async resolveModel(provider, model) { return { provider, id: model, name: model, inputModalities: ['text', 'image'], context: { contextWindow: 128000 } }; }
    async *stream(options) {
      options.signal?.throwIfAborted();
      if (++modelCalls > 24) throw new Error('Local migration fixture request cap reached');
      assert.equal(options.provider, 'zeta-backup-fixture');
      const value = runtime();
      const isLife = options.sessionId === value.state.life.sessionId;
      const hasProgress = options.messages.some(message => message.role === 'tool' && JSON.stringify(message).includes(PROGRESS));
      const hasNextPlan = options.messages.some(message => message.role === 'tool' && JSON.stringify(message).includes(NEXT_PLAN));
      const human = [...options.messages].reverse().find(message => message.role === 'user' && message.source?.kind === 'user');
      const saveMemory = (JSON.stringify(human) || '').includes('MIGRATION_SEED_ONE') && !options.messages.some(message => message.role === 'tool' && JSON.stringify(message).includes(MEMORY));
      const needsIdentity = (isLife && !value.state.settings.habits.includes(LIFE_HABIT)) || ((JSON.stringify(human) || '').includes('MIGRATION_SEED_ONE') && !value.state.settings.habits.includes(QQ_HABIT));
      const identity = latestIdentityResult(options.messages);
      if (options.purpose !== 'compaction' && (needsIdentity || (isLife && (!hasProgress || !hasNextPlan)) || saveMemory)) {
        const id = `migration_${randomUUID()}`;
        const name = needsIdentity ? identity ? 'zeta_identity_update' : 'zeta_identity_get' : isLife ? hasProgress ? 'zeta_life_plan_next' : 'zeta_life_update' : 'zeta_memory_set';
        const argumentsValue = JSON.stringify(needsIdentity ? identity ? { expected_revision: identity.revision,
          reason: isLife ? LIFE_IDENTITY_REASON : QQ_IDENTITY_REASON,
          ...(isLife ? { habits: [...identity.habits.filter(item => item !== LIFE_HABIT), LIFE_HABIT] } : { name: IDENTITY_NAME, persona: IDENTITY_PERSONA, habits: [QQ_HABIT] }) } : {} :
          isLife ? hasProgress ? { delay_minutes: 1440, reason: NEXT_PLAN } : { summary: PROGRESS, focus: 'Continue after deliberate activation on the new computer' } : { key: 'migration-preference', value: MEMORY, tags: ['fixture'] });
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsValue };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsValue } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        const text = options.purpose === 'compaction' ? 'Local fixture summary: user prefers portable memories.' : 'Local native migration fixture turn completed.';
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
  }
  const removeModel = ctx.llm.registerAdapter(['zeta-backup-fixture'], new FixtureModel());
  function makeManager() {
    const value = runtime();
    manager = new SessionManager(ctx, ctx.agents, ConfigSchema(value.exportQQConfiguration()), { info() {}, warn() {}, error() {}, debug() {} });
    value.attachGateway({ manager, sender: { async sendMarkdown() { fakeSends++; throw new Error('No real QQ delivery is available in this fixture'); }, openStream() { fakeSends++; throw new Error('No real QQ stream is available'); } }, mediaSender: {} });
    return manager;
  }
  async function agent(id) { const found = await ctx.sessionController.resolveAgent(id); assert.ok(found.agent, 'Native Agent must be restorable'); return found.agent; }
  async function chat(target, text, attachmentContent = []) {
    const value = runtime(), binding = value.bindingFor(target);
    if (binding) value.beginRequest(target, [{ senderId: binding.peerId, messageId: `migration_${randomUUID()}`, text }], binding.scope === 'group');
    try {
      target.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }, ...attachmentContent] }));
      await target.whenIdle(); await ctx.sessions.flush(target.session);
    } finally { if (binding) value.endRequest(target); }
  }
  async function execute(target, name, args) {
    const result = await ctx.tools.execute({ callId: `migration_${randomUUID()}`, name, arguments: args, agent: target, signal: AbortSignal.timeout(15000) });
    assert.ok(!result.isError, 'Native fixture tool execution must succeed'); return result.value;
  }
  async function raw(id) {
    const handle = await ctx.sessionPersistence.open(id, 'read');
    try { const { events } = await handle.read(); return { id, header: handle.header, inheritedEventCount: handle.inheritedEventCount, events, count: events.length, eventsHash: hash(stable(events)) }; }
    finally { await handle.close(); }
  }
  async function materials(root, prefix = '') {
    const found = [];
    for (const child of await readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
      const name = prefix ? `${prefix}/${child.name}` : child.name; const path = join(root, child.name);
      if (child.isDirectory()) found.push(...await materials(path, name));
      else if (child.isFile() && /\.(?:png|jpe?g|gif|webp|wav)$/iu.test(name)) { const bytes = await readFile(path); found.push({ name, bytes: bytes.length, sha256: hash(bytes) }); }
    }
    return found;
  }
  async function scheduleSnapshot() {
    const values = [];
    for (const row of await schedule().catalog()) {
      const history = await schedule().history({ sessionId: row.sessionId, id: row.id, limit: 100 });
      assert.ok(!('code' in history)); assert.deepEqual(history.retention, { days: 7, records: 17 }, 'Bridge must inherit the existing native schedule retention configuration'); values.push({ row, history });
    }
    return values;
  }
  async function seed(originCookie) {
    assert.equal(config.machine, 'source'); assert.equal(seeded, undefined, 'Seed is a single external action');
    check((await ctx.sessionPersistence.list()).length === 0, 'Source starts with an empty native Session store');
    const value = runtime(); const activeManager = makeManager();
    await ctx.credentials.set(credentialRef('ZETA_MIMO_API_KEY'), MIMO);
    await ctx.credentials.set(credentialRef('ZETA_MINIMAX_API_KEY'), MINIMAX);
    const image = await ctx.attachments.saveImage({ data: png(), mediaType: 'image/png', name: 'migration-image.png' });
    const fileBytes = Buffer.from('Portable native attachment: exact fixture bytes.\n', 'utf8');
    const file = await ctx.attachments.saveFile({ data: fileBytes, name: 'migration-note.txt' });
    const qq = await activeManager.getOrCreate('c2c', 'alice', 'alice', { scope: 'c2c', targetId: 'alice', msgId: 'migration-fixture-only' });
    await value.bindRecord(qq);
    await chat(qq.agent, `MIGRATION_SEED_ONE: ${'Original fixture conversation. '.repeat(180)}`, [{ type: 'image', attachment: image }, { type: 'file', attachment: file }]);
    check(value.state.settings.name === IDENTITY_NAME && value.state.settings.persona === IDENTITY_PERSONA && value.state.settings.habits.includes(QQ_HABIT), 'Source ordinary QQ native turn independently evolves its shared identity before backup');
    check(value.state.identity.history.at(-1)?.sourceSessionId === qq.sessionId && value.state.identity.history.at(-1)?.reason === QQ_IDENTITY_REASON, 'Source ordinary QQ identity write retains its genuine Session and reason');
    await chat(qq.agent, 'MIGRATION_SECOND_TURN: preserve every original event.');
    appendPluginRecord(qq.agent.session, 'plugin:zeta-backup-fixture/portable-state', { code: 'experimental fixture marker', nested: { preserved: true } });
    const compact = await activeManager.compact('c2c', 'alice');
    check(compact.ok === true, 'Source native compaction operation completes using the local fixture model');
    const group = await activeManager.getOrCreate('group', 'friends', 'group-member', { scope: 'group', targetId: 'friends', msgId: 'migration-fixture-only' });
    await value.bindRecord(group); await chat(group.agent, 'Migration fixture real group conversation.');
    await value.state.renameConversation(APP_ID, 'group:friends', '迁移测试群');
    const groupBuffer = [{ messageId: 'unconsumed-local-migration-message', senderId: 'group-member', senderName: 'Fixture friend', content: 'Pending group context survives computer migration.', timestamp: Date.now() }];
    for (const entry of groupBuffer) await getHistoryStore().append(historyGroupKey(APP_ID, 'friends'), entry, 1000);
    const child = await ctx.sessionController.fork({ sessionId: qq.sessionId });
    await value.state.bind({ key: `qq:${APP_ID}:c2c:alice`, appId: APP_ID, scope: 'c2c', peerId: 'alice', sessionId: child.sessionId });
    const forkAgent = await agent(child.sessionId); await ctx.sessions.flush(forkAgent.session);
    check((await raw(child.sessionId)).inheritedEventCount > 0, 'Source includes a genuine native fork with an inherited prefix');
    await activeManager.setModelOverride('c2c', 'alice', { provider: 'zeta-backup-fixture', model: 'fixture-2' });
    const prefs = new PrefsStore(); const peerKey = `qqbot:${APP_ID}:c2c:alice`;
    prefs.setSessionId(peerKey, child.sessionId); prefs.setPreset(peerKey, (await ctx.agentPresets.resolve()).id);
    const settings = value.state.settings;
    await value.state.setSettings({ ...settings, speech: { ...settings.speech, enabled: true } });
    // The public meme endpoint writes the actual collection index and originals.
    const memeResponse = await fetch(`http://127.0.0.1:${config.port}/zeta/api/memes`, { method: 'POST', headers: { cookie: originCookie, 'content-type': 'application/json' }, body: JSON.stringify({ space: `qq:${APP_ID}:c2c:alice`, base64: png().toString('base64'), fileName: 'migration-meme.png', caption: '迁移测试表情', tag: 'migration', keywords: ['fixture'] }), signal: AbortSignal.timeout(15000) });
    assert.equal(memeResponse.status, 200, 'Source meme management API must accept the fixture image'); await memeResponse.body?.cancel();
    const { generateSpeech } = await local('zeta/speech.js');
    await generateSpeech(value, value.state.speech, { text: '只在本地生成迁移音频样本', provider: 'mimo', send: false }, { agent: qq.agent, callId: 'migration-native-speech', signal: AbortSignal.timeout(15000) }, { fetch: async () => { fakeTtsCalls++; return new Response(JSON.stringify({ id: 'local-fixture-audio', choices: [{ finish_reason: 'stop', message: { audio: { data: WAVE.toString('base64') } } }] }), { headers: { 'content-type': 'application/json' } }); } });
    // Reserve a future one-shot before enabling; bootstrap must not race the deliberate local test turn.
    await value.state.updateLife(current => ({ ...current, planningInitialized: true, planRevision: current.planRevision + 1, runId: randomUUID(), nextWakeAt: Date.now() + 86400000, nextWakeReason: NEXT_PLAN }));
    const lifeSettings = { ...value.state.settings, life: { ...value.state.settings.life, enabled: true, quietStart: 0, quietEnd: 0, allowContact: false, readTargets: ['group:friends'], targets: [] } };
    const configured = await fetch(`http://127.0.0.1:${config.port}/zeta/api/settings`, { method: 'PUT', headers: { cookie: originCookie, 'content-type': 'application/json' }, body: JSON.stringify(lifeSettings) });
    assert.equal(configured.status, 200); const configuredValue = await configured.json(); assert.ok(!configuredValue.warning, 'Native life schedule must start with a local fixture model');
    const lifeQueued = await fetch(`http://127.0.0.1:${config.port}/zeta/api/life/run`, { method: 'POST', headers: { cookie: originCookie, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(lifeQueued.status, 200); assert.equal((await lifeQueued.json()).accepted, true);
    const life = await agent(value.state.life.sessionId); await life.whenIdle(); await ctx.sessions.flush(life.session);
    const settledLife = await fetch(`http://127.0.0.1:${config.port}/zeta/api/settings`, { method: 'PUT', headers: { cookie: originCookie, 'content-type': 'application/json' }, body: JSON.stringify(value.state.settings) });
    assert.equal(settledLife.status, 200); assert.ok(!(await settledLife.json()).warning, 'AI-planned native one-shot settles before backup');
    check(value.state.life.summary === PROGRESS, 'Source native life turn stores real local fixture progress');
    check(value.state.life.nextWakeReason === NEXT_PLAN && value.state.life.nextWakeAt > Date.now(), 'Source preserves the AI-selected next activity rather than a fixed interval');
    check(value.state.settings.habits.includes(QQ_HABIT) && value.state.settings.habits.includes(LIFE_HABIT) && value.state.identity.history.at(-1)?.reason === LIFE_IDENTITY_REASON && value.state.identity.history.at(-1)?.sourceSessionId === life.id, 'Source autonomous native turn evolves habits without losing the QQ-authored global identity or audit attribution');
    for (const actor of [forkAgent, life]) {
      const before = value.state.identity;
      const denied = await ctx.tools.execute({ callId: `migration_${randomUUID()}`, name: 'zeta_settings_update', arguments: { changes: { life: { allowContact: true } } }, agent: actor, signal: AbortSignal.timeout(15000) });
      check(denied.isError === true && value.state.settings.life.allowContact === false, 'Identity authorship in QQ or life does not grant sensitive configuration before backup');
      assert.deepEqual(value.state.identity, before);
    }
    await schedule().create(qq.sessionId, { title: 'Portable future fixture task', prompt: 'MIGRATION_FUTURE_TASK', every_seconds: 86400 });
    const delivered = await schedule().create(qq.sessionId, { title: 'Portable saved delivery', prompt: 'MIGRATION_NATIVE_REMINDER', after_seconds: 1 });
    const deadline = Date.now() + 15000;
    for (;;) {
      const history = await schedule().history({ sessionId: qq.sessionId, id: delivered.id, limit: 100 });
      if (!('code' in history) && history.records.length) break;
      assert.ok(Date.now() < deadline, 'Native one-shot schedule must record a durable delivery');
      await new Promise(accept => setTimeout(accept, 50));
    }
    await qq.agent.whenIdle();
    for (const session of ctx.sessions.list()) await ctx.sessions.flush(session);
    const sessions = [];
    for (const row of await ctx.sessionPersistence.list()) { const item = await raw(row.header.id); const { events, ...metadata } = item; sessions.push(metadata); }
    const storedImage = await ctx.attachments.readImage(image);
    const report = { checks: [...checks], modelCalls, fakeTtsCalls, fakeSends, appId: APP_ID, qqSessionId: qq.sessionId, currentSessionId: child.sessionId, groupSessionId: group.sessionId, lifeSessionId: life.id,
      sessions, attachments: [{ kind: 'image', ref: image, sha256: hash(storedImage.data) }, { kind: 'file', ref: file, sha256: hash(fileBytes) }],
      memories: value.state.listMemory(`qq:${APP_ID}:c2c:alice`), identity: value.state.identity, materials: await materials(value.dataDir), schedules: await scheduleSnapshot(), groupBuffer,
      prefs: JSON.parse(await readFile(join(config.home, 'zeta/qq-model-prefs.json'), 'utf8')), sourceDataDir: value.dataDir, sourceWorkspace: config.workspace };
    check(report.materials.some(item => item.name.endsWith('.wav')) && report.materials.some(item => item.name.endsWith('.png')), 'Source contains real meme and WAV files');
    check(fakeSends === 0 && fakeTtsCalls === 1, 'Source uses only the mock TTS response and makes no QQ deliveries');
    seeded = { ...report, checks: [...checks] }; return seeded;
  }
  async function verify(expected) {
    assert.equal(config.machine, 'target'); const value = runtime();
    const migration = value.state.migration;
    check(!!migration && migration.status === 'complete' && migration.pendingSchedules.length === 0 && !migration.error, 'Target startup bridge finishes importing all pending native schedules');
    check(modelCalls === 0 && fakeSends === 0, 'Restore and target startup make no model or QQ request');
    check(value.exportQQConfiguration().zeta?.connectQQ === false && !value.state.settings.life.enabled && !value.state.settings.life.allowContact, 'Restored QQ connection and autonomous contact remain paused');
    check(value.dataDir === migration.dataRoot && value.dataDir !== expected.sourceDataDir, 'Target loads the newly mapped material root after restart');
    assert.deepEqual(value.state.identity, expected.identity, 'The authoritative identity, revision, timestamp and complete audit history must survive encrypted migration and target restart');
    check(value.state.settings.name === expected.identity.name && value.state.settings.persona === expected.identity.persona && stable(value.state.settings.habits) === stable(expected.identity.habits), 'Target settings expose exactly the migrated QQ and life-authored identity while all external work stays paused');
    check(value.state.identity.history.some(item => item.reason === QQ_IDENTITY_REASON && item.sourceSessionId === expected.qqSessionId) && value.state.identity.history.some(item => item.reason === LIFE_IDENTITY_REASON && item.sourceSessionId === expected.lifeSessionId), 'Both ordinary QQ and autonomous identity audit records retain their original native Session identities');
    for (const expectedSession of expected.sessions) {
      check(!ctx.agents.get(expectedSession.id), 'Imported native Session stays cold until explicitly resumed');
      const item = await raw(expectedSession.id);
      check(item.count === expectedSession.count && item.eventsHash === expectedSession.eventsHash && item.inheritedEventCount === expectedSession.inheritedEventCount, 'Every original native event and inherited prefix survives migration');
      const originalHeader = { ...expectedSession.header }; const actualHeader = { ...item.header }; delete originalHeader.cwd; delete actualHeader.cwd;
      assert.deepEqual(actualHeader, originalHeader, 'All native header fields except mapped cwd must remain unchanged');
      check(item.header.cwd === resolve(migration.workspaceRoot, hash(expectedSession.header.cwd || '')) && (await stat(item.header.cwd)).isDirectory(), 'Native Session cwd maps to an existing directory on the target computer');
    }
    check((await ctx.sessionPersistence.list()).length === expected.sessions.length, 'No duplicate or substitute native Sessions are created');
    for (const attachment of expected.attachments) {
      if (attachment.kind === 'image') { const found = await ctx.attachments.readImage(attachment.ref); check(hash(found.data) === attachment.sha256, 'Native image reference and verified bytes remain portable'); }
      else { const digest = createHash('sha256'); let bytes = 0; for await (const chunk of ctx.attachments.readFileStream(attachment.ref)) { bytes += chunk.length; digest.update(chunk); } check(bytes === attachment.ref.bytes && digest.digest('hex') === attachment.sha256, 'Native generic file reference and verified bytes remain portable'); }
    }
    assert.deepEqual(value.state.listMemory(`qq:${APP_ID}:c2c:alice`), expected.memories, 'Persistent memories must retain all original fields');
    check(value.state.conversations(APP_ID).some(row => row.target === 'group:friends' && row.alias === '迁移测试群'), 'QQ conversation aliases survive migration');
    assert.deepEqual(await getHistoryStore().list(historyGroupKey(APP_ID, 'friends'), 1000), expected.groupBuffer, 'Pending group context survives profile reload and deliberate target restart');
    check(value.state.migration.groupBuffers.some(group => group.appId === APP_ID && group.peerId === 'friends'), 'Unconsumed group context keeps its durable restore record');
    check(value.state.life.sessionId === expected.lifeSessionId && value.state.life.summary === PROGRESS, 'Life identity and genuine progress remain preserved while paused');
    const prefs = JSON.parse(await readFile(join(config.home, 'zeta/qq-model-prefs.json'), 'utf8'));
    assert.deepEqual(prefs, expected.prefs, 'QQ model, preset and current-Session preferences must survive migration');
    check((await ctx.credentials.resolve(credentialRef('ZETA_MIMO_API_KEY')))?.value === MIMO && (await ctx.credentials.resolve(credentialRef('ZETA_MINIMAX_API_KEY')))?.value === MINIMAX, 'Native credential service restores the two fake TTS credentials without exposing them');
    check(value.exportQQConfiguration().appId === APP_ID && value.exportQQConfiguration().appSecret === QQ_SECRET, 'Encrypted QQ configuration restores the fake account credentials');
    check(value.exportQQConfiguration().sendFile?.extraRoots.length === 0, 'Target does not inherit external file roots from the source computer');
    for (const material of expected.materials) { const bytes = await readFile(join(value.dataDir, ...material.name.split('/'))); check(bytes.length === material.bytes && hash(bytes) === material.sha256, 'Original meme and speech material hashes survive migration'); }
    for (const task of expected.schedules) {
      const row = (await schedule().catalog()).find(item => item.id === task.row.id);
      check(!!row && row.status === 'inactive', 'Original native task ID is retained with delivery paused');
      const expectedRow = { ...task.row, status: 'inactive' }; assert.deepEqual(row, expectedRow, 'Native task rule, anchor and last delivery must remain unchanged');
      const history = await schedule().history({ sessionId: row.sessionId, id: row.id, limit: 100 });
      assert.deepEqual(history, task.history, 'Native retained delivery history must remain unchanged');
    }
    check((await schedule().catalog()).length === expected.schedules.length, 'Schedule bridge creates no duplicate native tasks');
    const { listSpeechFiles } = await local('zeta/speech.js');
    const speech = await listSpeechFiles(value, value.managementAgent(`qq:${APP_ID}:c2c:alice`));
    check(speech.length === 1 && !relative(value.dataDir, speech[0].filePath).startsWith('..'), 'Speech metadata resolves the copied WAV at its new material root');
    check(modelCalls === 0 && fakeSends === 0 && fakeTtsCalls === 0, 'All target verification reads remain cold and make no paid requests');
    return { checks: [...checks], modelCalls, fakeSends, sessions: expected.sessions.length, schedules: expected.schedules.length };
  }
  async function resume(expected) {
    const value = runtime(); const activeManager = makeManager();
    const qq = await activeManager.getOrCreate('c2c', 'alice', 'alice', { scope: 'c2c', targetId: 'alice', msgId: 'migration-fixture-only' });
    check(qq.sessionId === expected.currentSessionId, 'Native QQ SessionManager resumes the migrated current fork identity');
    await value.bindRecord(qq); const before = modelCalls;
    await chat(qq.agent, 'MIGRATION_RESUME_PROOF: continue the restored conversation with the local fixture.');
    check(modelCalls === before + 1 && fakeSends === 0, 'Restored QQ conversation completes a new native turn using only the local fixture model');
    const old = expected.sessions.find(item => item.id === qq.sessionId); const after = await raw(qq.sessionId);
    check(hash(stable(after.events.slice(0, old.count))) === old.eventsHash && after.inheritedEventCount === old.inheritedEventCount, 'Continuing a restored Session preserves its entire original event prefix');
    return { checks: [...checks], modelCalls, fakeSends, sessionId: qq.sessionId };
  }
  async function partial(expected) {
    const value = runtime();
    check(failedQQCommits === 1 && !failNextQQCommit, 'Fixture interrupts only the final QQ configuration commit');
    check(value.state.migration?.status === 'complete' && value.maintenance, 'An interrupted final configuration commit keeps the committed data behind the maintenance lock');
    check((await ctx.sessionPersistence.list()).length === expected.sessions.length && modelCalls === 0 && fakeSends === 0, 'The interrupted restore retains all imported native IDs without starting models or QQ');
    for (const old of expected.sessions) { const current = await raw(old.id); check(current.eventsHash === old.eventsHash && current.inheritedEventCount === old.inheritedEventCount, 'Interrupted restore leaves the complete original event prefix intact'); }
    return { checks: [...checks], failedQQCommits, modelCalls, fakeSends };
  }
  function activation() {
    const value = runtime();
    check(value.exportQQConfiguration().zeta?.connectQQ === true && fakeStarts === 1, 'Explicit owner activation persists QQ connection=true and starts only the local SDK mock');
    check(value.state.migration?.activationPending === false && value.state.migration?.qqPaused === false && value.state.migration?.restartRequired === false, 'Native configuration reload acknowledges the deliberate activation');
    check(!value.state.settings.life.enabled && fakeSends === 0, 'Explicit QQ activation preserves the independent autonomous-life pause and sends no message');
    return { checks: [...checks], fakeStarts, fakeSends, modelCalls };
  }
  const stop = ctx.webServer.register({ kind: 'prefix', path: '/zeta-backup-fixture', handler: async (req, res) => {
    const admission = ctx.connection.admit(req);
    if ('rejection' in admission || admission.peer.principal.kind !== 'owner') { res.writeHead('rejection' in admission ? admission.rejection : 403); res.end(); return; }
    try {
      const path = new URL(req.url, 'http://fixture').pathname.slice('/zeta-backup-fixture'.length);
      let data = {}; if (req.method === 'POST') { const parts = []; for await (const part of req) parts.push(part); data = JSON.parse(Buffer.concat(parts).toString() || '{}'); }
      let result;
      if (path === '/status') { const value = ctx.get('projectZeta'); result = { ready: !!value, modelCalls, fakeSends, fakeStarts, nativeSessions: (await ctx.sessionPersistence.list()).length, scheduleEntries: ctx.configEditor.configuration().filter(row => row.entry.options.id === 'schedule').map(row => ({ id: row.entry.options.id, name: row.entry.options.name })), migration: value?.state.migration ? { status: value.state.migration.status, pending: value.state.migration.pendingSchedules.length, qqPaused: value.state.migration.qqPaused, error: value.state.migration.error } : null }; }
      else if (path === '/seed') result = await seed(req.headers.cookie);
      else if (path === '/verify') result = await verify(data.expected);
      else if (path === '/resume') result = await resume(data.expected);
      else if (path === '/arm-commit-failure') { assert.equal(config.machine, 'target'); failNextQQCommit = true; result = { armed: true }; }
      else if (path === '/partial') result = await partial(data.expected);
      else if (path === '/activation') result = activation();
      else if (path === '/empty') { check((await ctx.sessionPersistence.list()).length === 0 && runtime().state.bindings().length === 0 && modelCalls === 0, 'Failed preview leaves the target native store and plugin state empty'); result = { checks: [...checks], modelCalls }; }
      else { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(result));
    } catch (error) {
      const value = ctx.get('projectZeta'); const life = value?.state.life;
      const lifeLog = life?.sessionId ? await raw(life.sessionId).catch(() => undefined) : undefined;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error?.message || 'Local migration fixture failed', diagnostics: { modelCalls, fakeSends, migration: value?.state.migration, life, lifeLog } }));
    }
  } });
  ctx.effect(() => async () => {
    stop(); await manager?.disposeAll(); removeModel();
    if (editor.edit === observedEdit) editor.edit = edit;
    for (const item of observations) if (BackupService.prototype[item.method] === item.observed) BackupService.prototype[item.method] = item.original;
    for (const item of sdkMethods) if (QQBot.prototype[item.method] === item.observed) QQBot.prototype[item.method] = item.original;
  }, 'zeta.backup-host-fixture');
}
