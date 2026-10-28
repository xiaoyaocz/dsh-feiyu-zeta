// Test-only Cordis plugin. Loaded only by verify-host.mjs, never by the shipped bundle.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

export const name = 'zeta-host-verification';
export const inject = ['projectZeta', 'llm', 'tools', 'storageDomain', 'schedule', 'sessionController', 'agentDefaultModel', 'webServer', 'sessions', 'agents', 'agentPresets', 'connection'];

export async function apply(ctx, config) {
  const { LlmAdapter, createUserMessage } = await import(pathToFileURL(join(config.moduleRoot, 'dsh-llm/lib/index.js')).href);
  const runtime = ctx.projectZeta;
  const checks = [];
  let modelCalls = 0;
  let echoCalls = 0;
  let injectedMemory = false;
  let lifeSawSharedIdentity = false;
  let debug;
  let task;
  let manager;
  let cookie;
  const fakeDeliveries = [];
  const fixtureTarget = 'group:fixture-group';
  const administrator = 'zeta-fixture-administrator';
  const plannedReason = 'Local native life fixture selected tomorrow';
  const identityName = '小鲸鱼·原生宿主验证';
  const identityPersona = '保持好奇，认真完成答应的事，允许自己安静探索。';
  const ordinaryHabit = 'host-fixture-listen-before-reply';
  const lifeHabit = 'host-fixture-review-real-progress';
  const ordinaryIdentityReason = 'Ordinary native QQ identity fixture evolution';
  const lifeIdentityReason = 'Autonomous native life identity fixture evolution';
  const assertCheck = (condition, description) => { assert.ok(condition, description); checks.push(description); };
  function latestIdentityResult(messages) {
    for (const message of [...messages].reverse()) {
      if (message.role !== 'tool') continue;
      for (const block of message.content || []) {
        if (block.type !== 'text') continue;
        try { const value = JSON.parse(block.text); if (typeof value.name === 'string' && typeof value.persona === 'string' && Array.isArray(value.habits) && Number.isInteger(value.revision)) return value; } catch { /* Other tools need not return identity JSON. */ }
      }
    }
  }
  class LocalFixture extends LlmAdapter {
    async listModels(provider) { return [{ provider, id: 'fixture', name: 'Local verification fixture' }, { provider, id: 'fixture-2', name: 'Local verification fixture 2' }]; }
    async *stream(options) {
      options.signal?.throwIfAborted();
      if (++modelCalls > 20) throw new Error('Fixture request limit exceeded');
      assert.equal(options.provider, 'zeta-host-fixture');
      assert.ok(options.model === 'fixture' || options.model === 'fixture-2');
      const raw = JSON.stringify(options.messages);
      if (raw.includes('zeta-host-memory-marker')) injectedMemory = true;
      const isLoopProbe = options.messages.some(message => message.role === 'user' && JSON.stringify(message).includes('ZETA_LOOP_PROBE'));
      const alreadyEchoed = options.messages.some(message => message.role === 'tool' && JSON.stringify(message).includes('zeta-host-echo-marker'));
      const isLife = options.sessionId === runtime.state.life.sessionId;
      if (isLife && raw.includes(identityName) && raw.includes(identityPersona)) lifeSawSharedIdentity = true;
      const isIdentity = options.messages.some(message => message.role === 'user' && JSON.stringify(message).includes('ZETA_IDENTITY_PROBE'));
      const identity = latestIdentityResult(options.messages);
      const needsIdentity = (isIdentity && !runtime.state.settings.habits?.includes(ordinaryHabit)) || (isLife && !runtime.state.settings.habits?.includes(lifeHabit));
      const alreadyUpdated = options.messages.some(message => message.role === 'tool' && JSON.stringify(message).includes('Local native life fixture turn completed'));
      const alreadyPlanned = options.messages.some(message => message.role === 'tool' && JSON.stringify(message).includes(plannedReason));
      if (needsIdentity || (isLoopProbe && !alreadyEchoed) || (isLife && (!alreadyUpdated || !alreadyPlanned))) {
        const id = `fixture_${randomUUID()}`;
        const toolName = needsIdentity ? identity ? 'zeta_identity_update' : 'zeta_identity_get' : isLife ? alreadyUpdated ? 'zeta_life_plan_next' : 'zeta_life_update' : 'zeta_host_probe_echo';
        const args = JSON.stringify(needsIdentity ? identity ? { expected_revision: identity.revision,
          reason: isLife ? lifeIdentityReason : ordinaryIdentityReason,
          ...(isLife ? { habits: [...identity.habits.filter(item => item !== lifeHabit), lifeHabit] } : { name: identityName, persona: identityPersona, habits: [ordinaryHabit] }) } : {} :
          isLife ? alreadyUpdated ? { delay_minutes: 1440, reason: plannedReason } : { summary: 'Local native life fixture turn completed', focus: 'Verify persistence after restart' } : { text: 'zeta-host-echo-marker' });
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id, name: toolName, argumentsDelta: args };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: toolName, arguments: args } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        const text = 'Local fixture completed. No external model or QQ request was made.';
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
  }
  const unregisterAdapter = ctx.llm.registerAdapter(['zeta-host-fixture'], new LocalFixture());
  const unregisterTool = ctx.tools.register({
    name: 'zeta_host_probe_echo', description: 'Local verification fixture echo; no network or file effects.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, exec) => { exec.signal.throwIfAborted(); echoCalls++; return { text: args.text }; },
  });
  async function request(path, method = 'GET', body, headers = {}, expectedStatus = 200) {
    const response = await fetch(`http://127.0.0.1:${config.port}/zeta/api${path}`, { method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    assert.equal(response.status, expectedStatus, JSON.stringify(data));
    if (data.warning) throw new Error(data.warning);
    return data;
  }
  async function resolve(id) { const result = await ctx.sessionController.resolveAgent(id); assert.ok(result.agent, String(result.error)); return result.agent; }
  async function create(peerId, key = `qq:zeta-fixture:c2c:${peerId}`) {
    const { sessionId } = await ctx.sessionController.create({ cwd: config.workspace });
    await runtime.state.bind({ key, appId: 'zeta-fixture', scope: 'c2c', peerId, sessionId });
    return resolve(sessionId);
  }
  async function execute(agent, toolName, args) {
    const result = await ctx.tools.execute({ callId: `fixture_${randomUUID()}`, name: toolName, arguments: args, agent, signal: AbortSignal.timeout(15000) });
    assert.equal(result.isError, false, JSON.stringify(result));
    return result.value;
  }
  async function rejectsTool(agent, name, args, description) {
    const before = fakeDeliveries.length;
    const result = await ctx.tools.execute({ callId: `fixture_${randomUUID()}`, name, arguments: args, agent, signal: AbortSignal.timeout(15000) });
    assertCheck(result.isError === true && fakeDeliveries.length === before, description);
  }
  function attachFakeGateway() {
    runtime.attachGateway({ manager,
      sender: { async sendMarkdown(target, text) { fakeDeliveries.push({ target, text }); return { id: `fixture-receipt-${fakeDeliveries.length}` }; }, openStream() { throw new Error('Fixture must not stream QQ messages'); } },
      mediaSender: new Proxy({}, { get: () => () => { throw new Error('Fixture must not send QQ media'); } }),
    });
  }
  async function runChat(agent, text, useAdministrator = true) {
    const sourceText = runtime.beginRequest && useAdministrator ? `/admin ${text}` : text;
    const group = runtime.bindingFor(agent)?.scope === 'group';
    runtime.beginRequest?.(agent, [{ senderId: useAdministrator ? administrator : 'ordinary-identity-member', messageId: `fixture_${randomUUID()}`, text: sourceText }], group);
    try {
      if (group && runtime.beginRequest) await execute(agent, 'zeta_group_decide', { decision: 'reply' });
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: sourceText }] }));
      await agent.whenIdle();
      await ctx.sessions.flush(agent.session);
    } finally { runtime.endRequest?.(agent); }
  }
  function assertGroupPreview(preview, description) {
    assertCheck(preview.target === fixtureTarget && preview.messages.some(message => message.role === 'user' && message.text.includes('ZETA_GROUP_USER_MARKER')) && preview.messages.some(message => message.role === 'assistant' && message.text.includes('Local fixture completed')), description);
    const rendered = JSON.stringify(preview.messages);
    assertCheck(preview.messages.every(message => ['user', 'assistant'].includes(message.role)) && !/zeta_host_probe_echo|zeta-host-echo-marker|Current runtime context|system-prompt/.test(rendered), 'Conversation preview excludes system messages, synthetic context and tool results');
  }
  async function run() {
    try {
      const pluginManifest = JSON.parse(await readFile(join(config.pluginRoot, 'package.json'), 'utf8'));
      if (pluginManifest.name === 'dsh-feiyu-zeta') {
        assertCheck(pluginManifest.repository?.url === 'git+https://github.com/xiaoyaocz/dsh-feiyu-zeta.git', 'Installed plugin declares its own repository');
        for (const locale of ['zh', 'en']) {
          const metadata = JSON.parse(await readFile(join(config.pluginRoot, 'locale', `${locale}.json`), 'utf8'));
          assertCheck(metadata.meta.title === 'dsh-feiyu-zeta', `Installed ${locale} plugin card uses the renamed title`);
        }
      }
      const { SessionManager } = await import(pathToFileURL(join(config.pluginRoot, 'dist/session/session-manager.js')).href);
      const { ConfigSchema } = await import(pathToFileURL(join(config.pluginRoot, 'dist/config.js')).href);
      manager = new SessionManager(ctx, ctx.agents, ConfigSchema({ appId: 'zeta-fixture', appSecret: 'unused-local-fixture', cwd: config.workspace }), { info() {}, warn() {}, error() {}, debug() {} });
      const origin = `http://127.0.0.1:${config.port}`;
      assertCheck(JSON.parse(await readFile(join(config.pluginRoot, 'package.json'), 'utf8')).version === config.expectedVersion, 'Real Host loads exactly the requested newly built package version');
      for (const [path, method] of [['/state', 'GET'], ['/settings', 'PUT']]) {
        const unauthenticated = await fetch(`${origin}/zeta/api${path}`, { method, ...(method === 'PUT' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}), signal: AbortSignal.timeout(15000) });
        assertCheck(unauthenticated.status === 401 || unauthenticated.status === 403, `Unauthenticated ${method} management request is rejected`);
      }
      const login = await fetch(ctx.connection.authenticatedUrl(`${origin}/`), { redirect: 'manual', signal: AbortSignal.timeout(15000) });
      assert.equal(login.status, 303, 'Native authenticated URL must exchange its token for a browser cookie');
      cookie = login.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
      assert.ok(cookie, 'Native browser login must issue an authenticated cookie');
      assertCheck(typeof (await request('/state')).version === 'string', 'Native authenticated browser cookie admits owner management requests');
      if (runtime.beginRequest) {
        await request('/settings', 'PUT', { ...runtime.state.settings, security: { administrators: [administrator] } });
        assertCheck(runtime.state.settings.security.administrators.includes(administrator), 'Owner configures a trusted fixture QQ administrator');
      }
      assertCheck(!!ctx.storageDomain && !!ctx.schedule && !!ctx.sessionController, 'Normal Web Host provides storageDomain, schedule and sessionController');
      for (const toolName of ['zeta_memory_set', 'zeta_memory_get', 'zeta_memory_search', 'zeta_memory_delete', 'zeta_speech_generate', 'send_meme', 'zeta_life_update']) {
        assertCheck(!!ctx.tools.get(toolName), `Host registered ${toolName}`);
      }
      if (config.phase !== 0) for (const toolName of ['zeta_conversation_list', 'zeta_conversation_read']) assertCheck(!!ctx.tools.get(toolName), `Host registered ${toolName}`);
      assertCheck(!runtime.state.settings.life.enabled || config.phase === 2, 'Autonomous life is off on first installation');
      if (config.phase === 0) {
        const legacy = await create('legacy-alice');
        await execute(legacy, 'zeta_memory_set', { key: 'legacy-preference', value: 'Legacy memory survives additive native-domain upgrade' });
        await runtime.state.setSettings({ ...runtime.state.settings, name: 'Legacy native upgrade fixture' });
        const group = await manager.getOrCreate('group', 'legacy-group', 'legacy-sender', { scope: 'group', targetId: 'legacy-group', msgId: 'local-fixture-only' });
        await runtime.bindRecord(group);
        await runChat(group.agent, 'ZETA_LOOP_PROBE: legacy group history before native-domain upgrade.');
        await writeFile(config.legacyFile, JSON.stringify({ sessionId: legacy.id, groupSessionId: group.sessionId, groupKey: 'qq:zeta-fixture:group:legacy-group', hadConversationDirectory: typeof runtime.state.conversations === 'function' }), 'utf8');
        assertCheck(runtime.state.settings.name === 'Legacy native upgrade fixture', 'Legacy package durably seeds a deliberately customized identity before upgrade');
        assertCheck(modelCalls === 2 && echoCalls === 1, 'Legacy native QQ Agent and Session history are durably seeded');
      } else if (config.phase === 1) {
        assert.equal(modelCalls, 0);
        if (config.legacyFile) {
          const old = JSON.parse(await readFile(config.legacyFile, 'utf8'));
          assertCheck(runtime.state.settings.name === 'Legacy native upgrade fixture', 'Additive native-domain upgrade preserves legacy settings');
          assertCheck(runtime.state.settings.conversations.allowCrossRead && runtime.state.settings.conversations.allowCrossSend, 'Legacy settings receive the new cross-conversation defaults');
          assertCheck(runtime.state.conversations('zeta-fixture').some(record => record.key === old.groupKey && record.sessionId === old.groupSessionId), 'Native domain upgrade preserves or backfills the conversation directory from legacy QQ bindings');
          assertCheck((await execute(await resolve(old.sessionId), 'zeta_memory_get', { key: 'legacy-preference' }))[0]?.value === 'Legacy memory survives additive native-domain upgrade', 'Additive native-domain upgrade preserves old persistent memory');
          assertCheck(!ctx.agents.get(old.groupSessionId), 'Legacy group Session remains cold while its directory binding migrates');
        }
        const alice = await create('alice');
        const bob = await create('bob');
        await execute(alice, 'zeta_memory_set', { key: 'fixture-preference', value: 'zeta-host-memory-marker', tags: ['fixture'] });
        assertCheck((await execute(alice, 'zeta_memory_get', { key: 'fixture-preference' }))[0]?.value === 'zeta-host-memory-marker', 'Native tool pipeline writes and reads persistent memory');
        assertCheck((await execute(bob, 'zeta_memory_get', { key: 'fixture-preference' })).length === 0, 'Different QQ peer cannot read Alice memory');
        const aliceNew = await create('alice');
        assertCheck((await execute(aliceNew, 'zeta_memory_search', { query: 'zeta-host-memory-marker' })).length === 1, 'New Session inherits memory through stable QQ binding');
        const unbound = await ctx.sessionController.create({ cwd: config.workspace });
        const denied = await ctx.tools.execute({ callId: `fixture_${randomUUID()}`, name: 'zeta_memory_get', arguments: {}, agent: await resolve(unbound.sessionId), signal: AbortSignal.timeout(15000) });
        assertCheck(denied.isError, 'Unbound Session cannot claim a QQ memory space');
        for (const toolName of ['zeta_identity_get', 'zeta_identity_update']) assertCheck(!!ctx.tools.get(toolName), `Host registered ${toolName}`);
        if (!config.legacyFile) assertCheck(runtime.state.settings.name === '小鲸鱼' && runtime.state.settings.habits.length > 0, 'Fresh Host starts with the community-inspired original small-whale identity and separate habits');
        const staleForm = runtime.state.settings, staleRevision = runtime.state.identity.revision;
        const identityAgent = await create('identity-member');
        const settingsBeforeIdentity = runtime.state.settings;
        await runChat(identityAgent, 'ZETA_IDENTITY_PROBE: independently evolve your own name, persona and habits.', false);
        const changedIdentity = runtime.state.identity;
        assertCheck(changedIdentity.name === identityName && changedIdentity.persona === identityPersona && changedIdentity.habits.includes(ordinaryHabit), 'Ordinary QQ native Agent reads and evolves its own name, persona and habits without /admin');
        assertCheck(changedIdentity.revision === staleRevision + 1 && changedIdentity.history.at(-1).sourceSessionId === identityAgent.id && changedIdentity.history.at(-1).reason === ordinaryIdentityReason, 'Ordinary native identity write persists one revision and an attributed audit record');
        const publicIdentity = await execute(identityAgent, 'zeta_identity_get', {});
        assertCheck(publicIdentity.revision === changedIdentity.revision && !('history' in publicIdentity), 'Identity model tool exposes current state while keeping other-session audit history private');
        assert.deepEqual(runtime.state.settings.security, settingsBeforeIdentity.security); assert.deepEqual(runtime.state.settings.images, settingsBeforeIdentity.images);
        await rejectsTool(identityAgent, 'zeta_settings_update', { changes: { life: { allowContact: true } } }, 'Ordinary identity authorship never grants sensitive feature-setting writes');
        await rejectsTool(identityAgent, 'zeta_host_probe_echo', { text: 'self-written persona cannot authorize host tools' }, 'Ordinary identity authorship never grants unlisted host tools');
        await rejectsTool(identityAgent, 'zeta_identity_update', { expected_revision: changedIdentity.revision, reason: 'Sensitive mixed-field request must be rejected', name: 'Must not persist', security: { administrators: ['ordinary-identity-member'] } }, 'Identity schema rejects a mixed identity and administrator-permission write');
        await rejectsTool(identityAgent, 'zeta_identity_update', { expected_revision: staleRevision, reason: 'Stale native identity write must fail', name: 'Must not overwrite' }, 'Native identity write rejects a stale expected_revision');
        assert.deepEqual(runtime.state.identity, changedIdentity, 'Rejected sensitive and stale identity writes leave identity and audit history unchanged');
        await request('/settings', 'PUT', { ...staleForm, name: 'Stale owner form must not win' }, { 'x-zeta-identity-revision': String(staleRevision) }, 400);
        assert.deepEqual(runtime.state.identity, changedIdentity, 'Owner API rejects stale identity forms without modifying current identity');
        await request('/settings', 'PUT', { ...staleForm, memory: { ...staleForm.memory, maxItems: staleForm.memory.maxItems + 1 } });
        assertCheck(runtime.state.settings.name === identityName && runtime.state.settings.memory.maxItems === staleForm.memory.maxItems + 1 && runtime.state.identity.revision === changedIdentity.revision, 'Legacy client settings save updates features while preserving newer autonomous identity');
        const ownerState = await request('/state');
        await request('/settings', 'PUT', { ...runtime.state.settings, persona: `${identityPersona} Owner reviewed this current revision.` }, { 'x-zeta-identity-revision': String(ownerState.identity.revision) });
        assertCheck(runtime.state.identity.revision === changedIdentity.revision + 1 && runtime.state.identity.persona.includes('Owner reviewed'), 'Owner API changes current identity only with the matching explicit revision header');
        await rejectsTool(aliceNew, 'zeta_host_probe_echo', { text: 'ordinary requester' }, 'Ordinary QQ actor cannot invoke an unlisted host tool');
        assertCheck(echoCalls === 0, 'Denied ordinary host-tool call has no tool-body side effect');
        await runChat(aliceNew, 'ZETA_LOOP_PROBE: execute the local echo fixture once.');
        debug = await ctx.sessionController.inspect(aliceNew.id);
        assertCheck(echoCalls === 1, 'Native Agent loop invokes a tool contributed by another plugin');
        assertCheck(injectedMemory, 'Native model request receives the scoped persistent memory context');
        await ctx.sessions.flush(aliceNew.session);
        const history = await ctx.sessionController.inspect(aliceNew.id);
        assertCheck(JSON.stringify(history.events).includes('zeta_host_probe_echo'), 'Native Session log persists the cross-plugin tool call');
        const qq = await manager.getOrCreate('c2c', 'qq-manager', 'qq-manager', { scope: 'c2c', targetId: 'qq-manager', msgId: 'local-fixture-only' });
        await runtime.bindRecord(qq);
        const beforeQQ = echoCalls;
        await runChat(qq.agent, 'ZETA_LOOP_PROBE: QQ SessionManager tool visibility.');
        debug = await ctx.sessionController.inspect(qq.sessionId);
        assertCheck(echoCalls === beforeQQ + 1, 'QQ SessionManager Agent invokes another plugin through the native tool pipeline');
        const eventsBeforeSwitch = debug.events.length;
        await manager.setModelOverride('c2c', 'qq-manager', { provider: 'zeta-host-fixture', model: 'fixture-2' });
        const switched = await manager.getOrCreate('c2c', 'qq-manager', 'qq-manager', qq.replyTarget);
        assertCheck(switched.agent === qq.agent && switched.sessionId === qq.sessionId, 'QQ model selection keeps the same Agent and Session');
        assertCheck((await ctx.sessionController.inspect(qq.sessionId)).events.length >= eventsBeforeSwitch, 'QQ model selection preserves the complete Session history');
        await ctx.sessions.flush(qq.agent.session);
        const group = await manager.getOrCreate('group', 'fixture-group', 'group-sender', { scope: 'group', targetId: 'fixture-group', msgId: 'local-fixture-only' });
        await runtime.bindRecord(group);
        await runChat(group.agent, 'ZETA_LOOP_PROBE: ZETA_GROUP_USER_MARKER, real group conversation text.');
        runtime.beginRequest(group.agent, [{ senderId: 'ordinary-group-member', messageId: `fixture_${randomUUID()}`, text: 'No reply is needed' }], true);
        try {
          await execute(group.agent, 'zeta_group_decide', { decision: 'skip' });
          await rejectsTool(group.agent, 'zeta_send_message', { text: '（不回复）' }, 'Group skip denies QQ delivery and never emits a silence placeholder');
        } finally { runtime.endRequest(group.agent); }
        attachFakeGateway();
        const directory = await execute(aliceNew, 'zeta_conversation_list', { scope: 'group' });
        assertCheck(directory.items.some(record => record.target === fixtureTarget && record.canRead && record.canSend), 'Ordinary QQ Agent discovers a known group with explicit readable and sendable target');
        const crossReceipt = await execute(aliceNew, 'zeta_send_message', { target: fixtureTarget, text: 'Local fixture cross-conversation greeting' });
        assertCheck(crossReceipt.status === 'accepted' && crossReceipt.target === fixtureTarget && fakeDeliveries.length === 1 && fakeDeliveries[0].target.scope === 'group' && fakeDeliveries[0].target.targetId === 'fixture-group', 'Ordinary private-chat Agent sends explicitly to the known group through a fake receipt sender');
        assertGroupPreview(await execute(aliceNew, 'zeta_conversation_read', { target: fixtureTarget }), 'Ordinary private-chat Agent reads real user and assistant text from the group Session');
        await rejectsTool(aliceNew, 'zeta_send_message', { target: 'group:unknown-group', text: 'Must not be delivered' }, 'Cross-conversation send rejects unknown group identities');
        await request('/settings', 'PUT', { ...runtime.state.settings, conversations: { allowCrossSend: false, allowCrossRead: false } });
        await rejectsTool(aliceNew, 'zeta_send_message', { target: fixtureTarget, text: 'Must not be delivered' }, 'Disabling ordinary cross-send blocks group delivery');
        await rejectsTool(aliceNew, 'zeta_conversation_read', { target: fixtureTarget }, 'Disabling ordinary cross-read blocks group inspection');
        await request('/settings', 'PUT', { ...runtime.state.settings, conversations: { allowCrossSend: true, allowCrossRead: true } });
        const callsBeforeSchedule = modelCalls;
        // Keep bootstrap from racing the deliberate manual turn in this probe.
        await runtime.state.updateLife(current => ({ ...current, planningInitialized: true, planRevision: current.planRevision + 1, runId: randomUUID(), nextWakeAt: Date.now() + 86400000, nextWakeReason: plannedReason }));
        await request('/settings', 'PUT', { ...runtime.state.settings, life: { ...runtime.state.settings.life, enabled: true, quietStart: 0, quietEnd: 0, allowContact: false, targets: [], readTargets: [fixtureTarget] } });
        const life = runtime.state.life;
        const schedules = await ctx.schedule.list({ sessionId: life.sessionId });
        assertCheck(!!life.sessionId && schedules.some(record => record.id === life.scheduleId && record.kind === 'at') && schedules.length === 1, 'Enabling autonomous life creates one native persistent one-shot instead of fixed recurrence');
        assertCheck(modelCalls === callsBeforeSchedule, 'Creating an autonomous schedule does not request a model');
        const queued = await request('/life/run', 'POST', {});
        assertCheck(queued.accepted === true && queued.status === 'queued' && queued.sessionId === life.sessionId, 'Manual autonomous life endpoint queues a native Session turn');
        const lifeAgent = await resolve(life.sessionId);
        await lifeAgent.whenIdle();
        const deadline = Date.now() + 5000;
        while (runtime.state.life.lastFinishedAt === 0 && Date.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait, 20));
        assertCheck(runtime.state.life.lastRunAt > 0 && runtime.state.life.lastFinishedAt > 0 && runtime.state.life.status !== 'running', 'Native life pre-step admission and turn-end persist a completed internal turn');
        assertCheck(runtime.state.life.summary === 'Local native life fixture turn completed', 'Internal life Agent persists actual fixture progress through zeta_life_update');
        assertCheck(lifeSawSharedIdentity && runtime.state.settings.habits.includes(ordinaryHabit) && runtime.state.settings.habits.includes(lifeHabit), 'Native life model sees QQ-evolved global identity and autonomously evolves its own habits');
        assertCheck(runtime.state.identity.history.at(-1).sourceSessionId === lifeAgent.id && runtime.state.identity.history.at(-1).reason === lifeIdentityReason, 'Autonomous native identity change retains the real life Session and adjustment reason');
        await rejectsTool(lifeAgent, 'zeta_settings_update', { changes: { life: { allowContact: true } } }, 'Self-directed life identity evolution does not grant sensitive feature configuration');
        await rejectsTool(lifeAgent, 'zeta_host_probe_echo', { text: 'must remain denied' }, 'Self-directed life identity evolution does not grant an unlisted host tool');
        await request('/settings', 'PUT', runtime.state.settings);
        const planned = runtime.state.life;
        const plannedSchedules = await ctx.schedule.list({ sessionId: life.sessionId });
        assertCheck(planned.nextWakeReason === plannedReason && planned.nextWakeAt > Date.now() && plannedSchedules.length === 1 && plannedSchedules[0].kind === 'at' && plannedSchedules[0].id === planned.scheduleId && planned.scheduleId !== life.scheduleId, 'Internal life Agent chooses a new one-shot through zeta_life_plan_next');
        await ctx.sessions.flush(lifeAgent.session);
        assertGroupPreview(await execute(lifeAgent, 'zeta_conversation_read', { target: fixtureTarget }), 'Internal life Agent reads the explicitly selected group without sending');
        await rejectsTool(lifeAgent, 'zeta_conversation_read', { target: 'c2c:bob' }, 'Life cannot read a known conversation outside readTargets');
        await rejectsTool(lifeAgent, 'zeta_send_message', { target: fixtureTarget, text: 'Must not be delivered' }, 'Life read permission does not grant contact permission');
        await request('/settings', 'PUT', { ...runtime.state.settings, life: { ...runtime.state.settings.life, allowContact: true, targets: [] } });
        await rejectsTool(lifeAgent, 'zeta_send_message', { target: fixtureTarget, text: 'Must not be delivered' }, 'Life contact permission still requires an explicit send target');
        await request('/settings', 'PUT', { ...runtime.state.settings, life: { ...runtime.state.settings.life, allowContact: true, targets: [fixtureTarget], dailyContactLimit: 1 } });
        const lifeReceipt = await execute(lifeAgent, 'zeta_send_message', { target: fixtureTarget, text: 'Local fixture authorized life contact' });
        assertCheck(lifeReceipt.status === 'accepted' && fakeDeliveries.length === 2 && runtime.state.life.contactCount === 1, 'Life explicit allowed target sends once and persists the contact count');
        await rejectsTool(lifeAgent, 'zeta_send_message', { target: fixtureTarget, text: 'Must not be delivered twice' }, 'Life daily contact limit prevents a second delivery');
        await request('/settings', 'PUT', { ...runtime.state.settings, life: { ...runtime.state.settings.life, allowContact: false, targets: [], readTargets: [] } });
        await rejectsTool(lifeAgent, 'zeta_conversation_read', { target: fixtureTarget }, 'Removing a life read target immediately prevents inspection');
        await request('/settings', 'PUT', { ...runtime.state.settings, life: { ...runtime.state.settings.life, readTargets: [fixtureTarget] } });
        await writeFile(config.stateFile, JSON.stringify({ aliceSessionId: aliceNew.id, qqSessionId: qq.sessionId, groupSessionId: group.sessionId, lifeSessionId: life.sessionId, identitySessionId: identityAgent.id, identity: runtime.state.identity, scheduleId: planned.scheduleId, nextWakeAt: planned.nextWakeAt }), 'utf8');
      } else {
        const saved = JSON.parse(await readFile(config.stateFile, 'utf8'));
        assert.deepEqual(runtime.state.identity, saved.identity, 'After Host restart the complete evolved identity, revision and audit history remain exact');
        assertCheck(runtime.state.settings.name === saved.identity.name && runtime.state.settings.persona === saved.identity.persona && JSON.stringify(runtime.state.settings.habits) === JSON.stringify(saved.identity.habits), 'After Host restart settings immediately expose the current authoritative identity');
        attachFakeGateway();
        assertCheck(!ctx.agents.get(saved.groupSessionId), 'After Host restart the group Agent is cold before cross-conversation inspection');
        assertGroupPreview(await execute(await resolve(saved.lifeSessionId), 'zeta_conversation_read', { target: fixtureTarget }), 'After Host restart life reads the persisted group conversation through native cold inspection');
        assertCheck(!ctx.agents.get(saved.groupSessionId) && modelCalls === 0 && fakeDeliveries.length === 0, 'Native cold conversation inspection neither activates the group Agent nor calls a model or sender');
        const qq = await manager.getOrCreate('c2c', 'qq-manager', 'qq-manager', { scope: 'c2c', targetId: 'qq-manager', msgId: 'local-fixture-only' });
        assertCheck(qq.sessionId === saved.qqSessionId, 'After Host restart QQ SessionManager resumes the original deterministic Session');
        assertCheck(JSON.stringify((await ctx.sessionController.inspect(qq.sessionId)).events).includes('zeta_host_probe_echo'), 'After Host restart QQ Session retains its cross-plugin tool history');
        const alice = await resolve(saved.aliceSessionId);
        assertCheck((await execute(alice, 'zeta_memory_get', { key: 'fixture-preference' }))[0]?.value === 'zeta-host-memory-marker', 'After Host restart memory and QQ binding remain persistent');
        assertCheck(runtime.state.life.sessionId === saved.lifeSessionId, 'After Host restart autonomous life reuses its original Session');
        assertCheck(runtime.state.life.summary === 'Local native life fixture turn completed' && runtime.state.life.lastFinishedAt > 0, 'After Host restart autonomous life progress and completion remain persistent');
        const schedules = await ctx.schedule.list({ sessionId: saved.lifeSessionId });
        assertCheck(schedules.filter(record => record.id === saved.scheduleId && record.kind === 'at').length === 1 && schedules.length === 1 && runtime.state.life.nextWakeAt === saved.nextWakeAt, 'After Host restart the AI-selected native one-shot and its original time remain');
        assertCheck(modelCalls === 0, 'Cold restore and schedule reconciliation make no model request');
        await request('/life/stop', 'POST', {});
        assertCheck(!(await ctx.schedule.list({ sessionId: saved.lifeSessionId })).some(record => record.id === saved.scheduleId), 'Explicit stop removes the native schedule');
        assertCheck(runtime.state.life.sessionId === saved.lifeSessionId && !runtime.state.settings.life.enabled, 'Explicit stop preserves Session and memory with life disabled');
        await execute(alice, 'zeta_memory_delete', { key: 'fixture-preference' });
        assertCheck((await execute(alice, 'zeta_memory_get', {})).length === 0, 'Native memory delete persists the requested removal');
      }
      await writeFile(config.resultFile, JSON.stringify({ ok: true, phase: config.phase, checks, modelCalls, echoCalls }, null, 2), 'utf8');
    } catch (error) {
      await writeFile(config.resultFile, JSON.stringify({ ok: false, phase: config.phase, checks, modelCalls, echoCalls, error: String(error?.stack || error), debug }, null, 2), 'utf8');
    }
  }
  // A one-shot test fixture waits until the ordinary Web startup has mounted routes.
  const timer = setTimeout(() => { task = run(); }, 1200);
  ctx.effect(() => async () => { clearTimeout(timer); await task; await manager?.disposeAll(); unregisterTool(); unregisterAdapter(); }, 'zeta.host-verification');
}
