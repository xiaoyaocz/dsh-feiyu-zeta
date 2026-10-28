#!/usr/bin/env node
// Two fresh native DSH homes simulate separate computers. No live profile is read.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
const require = createRequire(import.meta.url);
const tar = require('tar-stream');
const { discover } = require('./inspect-local-runtime.cjs');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageMetadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const pluginVersion = packageMetadata.version;
const pluginName = packageMetadata.name;
const PASSWORD = 'migration-fixture-口令';
const options = {};
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--help') { console.log(`node scripts/verify-backup-host.mjs --package <dsh-feiyu-zeta-${pluginVersion}.tgz> [--output <new-directory>] [--desktop-exe <path>] [--inspect-only]`); process.exit(0); }
  if (args[index] === '--inspect-only') options.inspectOnly = true;
  else if (['--package', '--output', '--desktop-exe'].includes(args[index]) && args[index + 1]) options[args[index].slice(2)] = args[++index];
  else throw new Error(`Unknown or incomplete argument: ${args[index]}`);
}
const runtime = discover(options['desktop-exe']);
if (options.inspectOnly) { console.log(JSON.stringify({ runtimeVersion: runtime.runtimeVersion, profile: 'web', separateHomes: 2, modifiesExistingProfiles: false }, null, 2)); process.exit(0); }
if (!options.package) throw new Error(`--package must name the built ${pluginVersion} plugin`);
const packageFile = resolve(options.package); await access(packageFile);
const output = resolve(options.output || join(root, 'output', `backup-host-verification-${new Date().toISOString().replace(/[:.]/g, '-')}`));
await mkdir(output, { recursive: false });
const checks = [];
const check = (condition, message) => { assert.ok(condition, message); checks.push(message); };
const progress = message => process.stdout.write(`[migration probe] ${message}\n`);
const redact = text => text.replace(/([?&]token=)[^&\s"']+/g, '$1[redacted]').replaceAll(PASSWORD, '[redacted]').replace(/fixture-(?:qq|mimo|minimax)-secret-[\w-]+/g, '[fixture secret redacted]');
async function port() { const server = createServer(); await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); }); const value = server.address().port; await new Promise(accept => server.close(accept)); return value; }
async function machine(name) {
  const directory = join(output, name); const home = join(directory, 'home'); const workspace = join(directory, 'workspace'); const user = join(directory, 'user');
  await mkdir(directory); await mkdir(home); await mkdir(workspace); await mkdir(user);
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, HOME: user, USERPROFILE: user, DSH_TELEMETRY_DISABLED: '1', DSH_TOOLS_MODE: 'native', DSH_PERMISSION_MODE: 'workspace-write' };
  for (const key of Object.keys(env)) if (/API[_-]?KEY|TOKEN|SECRET|PASSWORD|QQBOT|DEEPSEEK[_-]AUTH/i.test(key)) delete env[key];
  return { name, directory, home, workspace, user, data: join(directory, 'data'), env, port: await port(), generation: 0 };
}
function launch(target, cliArgs) {
  const child = spawn(runtime.executable, [runtime.cliPath, ...cliArgs], { cwd: target.workspace, env: target.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; let exited = false;
  child.stdout.on('data', value => { log = (log + value.toString()).slice(-250000); });
  child.stderr.on('data', value => { log = (log + value.toString()).slice(-250000); });
  const done = new Promise((accept, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { exited = true; accept({ code, signal }); }); });
  return { child, done, log: () => log, exited: () => exited };
}
async function install(target, file) {
  const process = launch(target, ['plugin', '--profile', 'web', 'add', file]); const result = await process.done;
  await writeFile(join(target.directory, 'install.log'), redact(process.log()), 'utf8');
  assert.equal(result.code, 0, `Native CLI installation failed; see ${target.name}/install.log`);
  const installed = JSON.parse(await readFile(join(target.home, 'profiles/web/node_modules/dsh-feiyu-zeta/package.json'), 'utf8'));
  assert.equal(installed.version, pluginVersion, 'Both simulated computers must install the freshly built current package');
}
async function initialPatch(target) {
  const patch = [
    { id: 'session-title-llm', disabled: true }, { id: 'session-telemetry-otel', disabled: true },
    { id: 'agent-default-model', config: { provider: 'zeta-backup-fixture', model: 'fixture' } },
    { id: 'tools', config: { mode: 'native' } },
    { id: 'schedule', config: { deliveryHistoryDays: target.name === 'source' ? 7 : 9, deliveryHistoryRecords: target.name === 'source' ? 17 : 19 } },
    { id: 'webserver', config: { host: '127.0.0.1', port: target.port, compression: 'none' } },
    { id: 'web-runtime', config: { openBrowser: false, printUrl: true, surfaceContext: true } },
    { id: 'im-qqbot', config: { appId: target.name === 'source' ? 'zeta-portable-fixture' : '', appSecret: target.name === 'source' ? 'fixture-qq-secret-no-live-account' : '', provider: 'zeta-backup-fixture', model: 'fixture', cwd: target.workspace, sendFile: { restrictPaths: true, extraRoots: target.name === 'source' ? [target.workspace] : [], sendPresentedFiles: false, maxFiles: 3 }, zeta: { connectQQ: false, dataDir: target.data } } },
    { insert: [{ id: 'zeta-backup-host-fixture', name: join(root, 'scripts/fixtures/backup-probe.mjs'), config: { machine: target.name, home: target.home, workspace: target.workspace, port: target.port, moduleRoot: runtime.moduleRoot, pluginRoot: join(target.home, 'profiles/web/node_modules/dsh-feiyu-zeta') } }] },
  ];
  // Configuration edits must win after restoration, so fixture options live in
  // the private profile's normal layer rather than a higher-priority --patch.
  await writeFile(join(target.home, 'profiles/web/cordis.patch.yml'), JSON.stringify(patch, null, 2), 'utf8');
}
async function request(target, path, { method = 'GET', json, body, headers, authenticated = true, timeout = 30000 } = {}) {
  return fetch(`http://127.0.0.1:${target.port}${path}`, { method, headers: { ...(authenticated ? { cookie: target.cookie } : {}), ...(json === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(json === undefined && body === undefined ? {} : { body: json === undefined ? body : JSON.stringify(json) }), signal: AbortSignal.timeout(timeout) });
}
async function jsonRequest(target, path, options) {
  const response = await request(target, path, options); const data = await response.json();
  if (data.diagnostics) await writeFile(join(target.directory, 'fixture-diagnostics.json'), JSON.stringify(data.diagnostics, null, 2), 'utf8');
  assert.equal(response.status, 200, `${target.name} ${path}: ${data.error || 'request failed'}`); return data;
}
async function waitFixture(target, predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const value = await jsonRequest(target, '/zeta-backup-fixture/status', { timeout: 3000 }); if (predicate(value)) return value; } catch { /* A profile edit can briefly remove the service. */ }
    if (target.process?.exited()) break;
    await delay(100);
  }
  throw new Error(`${target.name} Host did not reach the expected migration journal state`);
}
async function start(target) {
  target.generation++; target.process = launch(target, ['--profile', 'web']);
  const deadline = Date.now() + 60000;
  let loginUrl;
  while (Date.now() < deadline) {
    loginUrl = target.process.log().match(/dsh web:\s+(https?:\/\/[^\s]+\?token=[^\s]+)/)?.[1];
    if (loginUrl) break;
    if (target.process.exited()) throw new Error(`${target.name} Host exited during startup; log: ${join(target.directory, `host-${target.generation}.log`)}`);
    await delay(100);
  }
  assert.ok(loginUrl, `${target.name} Host did not publish its native authenticated URL`);
  const login = await fetch(loginUrl, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  assert.equal(login.status, 303, 'Native launch URL must exchange for an owner cookie');
  target.cookie = login.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
  assert.ok(target.cookie, 'Native login must issue a cookie');
  while (Date.now() < deadline) {
    try { const value = await jsonRequest(target, '/zeta-backup-fixture/status'); if (value.ready) return value; }
    catch { if (target.process.exited()) break; }
    await delay(150);
  }
  throw new Error(`${target.name} dsh-feiyu-zeta service did not become ready`);
}
async function stop(target) {
  if (!target.process) return;
  if (!target.process.exited()) target.process.child.kill();
  await target.process.done.catch(() => {});
  await writeFile(join(target.directory, `host-${target.generation}.log`), redact(target.process.log()), 'utf8');
  target.process = undefined; target.cookie = undefined;
}
async function download(target, path, destination, options) {
  const response = await request(target, path, options);
  if (response.status !== 200) { const problem = await response.json().catch(() => ({})); throw new Error(`${target.name} download failed: ${problem.error || response.status}`); }
  assert.ok(response.body);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
}
async function inspectPlugin(file) {
  const extract = tar.extract(); let manifest; let files = 0; let foundEntry = false;
  const incoming = pipeline(createReadStream(file), createGunzip(), extract);
  const consume = (async () => { for await (const entry of extract) {
    assert.equal(entry.header.type, 'file'); assert.ok(entry.header.name.startsWith('package/')); files++;
    const parts = []; for await (const part of entry) if (entry.header.name === 'package/package.json') parts.push(part);
    if (parts.length) manifest = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (entry.header.name === 'package/dist/index.js') foundEntry = true;
  } })();
  await Promise.all([incoming, consume]);
  check(manifest?.name === pluginName && manifest.version === pluginVersion && foundEntry && files > 20, 'Downloaded public plugin is a valid installable code-only npm tar.gz');
  return { files, version: manifest.version };
}
async function preview(target, archive, pass) {
  const response = await request(target, '/zeta/api/backup/preview', { method: 'POST', body: await readFile(archive), headers: { 'content-type': 'application/octet-stream', 'x-zeta-backup-password': Buffer.from(pass, 'utf8').toString('base64') }, timeout: 60000 });
  return { status: response.status, data: await response.json() };
}

const source = await machine('source'); const target = await machine('target');
let sourceReport; let cold; let resumed; let activated; let interrupted; let publicPlugin;
try {
  progress('Starting isolated source Host');
  await install(source, packageFile); await initialPatch(source); await start(source);
  progress('Seeding local native Sessions, attachments, memories, media and tasks');
  sourceReport = await jsonRequest(source, '/zeta-backup-fixture/seed', { method: 'POST', json: {}, timeout: 60000 });
  await writeFile(join(output, 'fixture-expected.json'), JSON.stringify(sourceReport, null, 2), 'utf8');
  check(sourceReport.fakeSends === 0 && sourceReport.fakeTtsCalls === 1 && sourceReport.attachments.length === 2, 'Source fixture seeds native chat, both attachment kinds, memories and local-only media');
  const archive = join(output, 'migration.zeta-backup');
  progress('Exporting encrypted migration archive');
  await download(source, '/zeta/api/backup/export', archive, { method: 'POST', json: { password: PASSWORD, includeCredentials: true }, timeout: 60000 });
  check((await readFile(archive)).subarray(0, 8).toString() === 'ZETABK01', 'Owner export produces the authenticated encrypted migration format');
  const plugin = join(output, `downloaded-dsh-feiyu-zeta-${pluginVersion}.tgz`);
  progress('Downloading and validating code-only installable plugin');
  await download(source, '/zeta/api/backup/plugin', plugin); publicPlugin = await inspectPlugin(plugin);
  await stop(source);
  // Install the downloaded package on the second simulated computer.
  progress('Installing downloaded plugin on isolated target Host');
  await install(target, plugin); await initialPatch(target); await start(target);
  const unauthorized = await request(target, '/zeta/api/backup/status', { authenticated: false });
  check(unauthorized.status === 401 || unauthorized.status === 403, 'Target backup management rejects an unauthenticated caller');
  const wrong = await preview(target, archive, 'intentionally incorrect fixture password');
  check(wrong.status === 400, 'Incorrect backup password is rejected before native import');
  await jsonRequest(target, '/zeta-backup-fixture/empty', { method: 'POST', json: {} });
  let approved = await preview(target, archive, PASSWORD);
  check(approved.status === 200 && approved.data.preview?.canRestore === true && typeof approved.data.token === 'string', 'Correct binary upload and UTF-8 password header produce a restorable preview');
  check(approved.data.preview.sessions === sourceReport.sessions.length && approved.data.preview.includesCredentials === true, 'Preview accounts for every native Session and the explicitly included fake credentials');
  const staleToken = approved.data.token;
  for (let attempt = 0; attempt < 4; attempt++) {
    approved = await preview(target, archive, PASSWORD);
    check(approved.status === 200 && approved.data.preview?.canRestore === true, 'Repeated owner preview retires old stages without blocking a fresh read-only preview');
  }
  const staleWrite = await request(target, '/zeta/api/backup/restore', { method: 'POST', json: { token: staleToken } });
  check(staleWrite.status === 400, 'An evicted preview token cannot start a restore');
  await staleWrite.body?.cancel();
  await jsonRequest(target, '/zeta-backup-fixture/empty', { method: 'POST', json: {} });
  await writeFile(join(output, 'preview-summary.json'), JSON.stringify(approved.data.preview, null, 2), 'utf8');
  progress('Interrupting the final configuration commit to verify safe continuation');
  await jsonRequest(target, '/zeta-backup-fixture/arm-commit-failure', { method: 'POST', json: {} });
  const failedCommit = await request(target, '/zeta/api/backup/restore', { method: 'POST', json: { token: approved.data.token }, timeout: 60000 });
  check(failedCommit.status === 400, 'A controlled final configuration failure does not claim a completed restore');
  await failedCommit.body?.cancel();
  await waitFixture(target, value => value.ready && value.migration?.status === 'complete');
  interrupted = await jsonRequest(target, '/zeta-backup-fixture/partial', { method: 'POST', json: { expected: sourceReport } });
  approved = await preview(target, archive, PASSWORD);
  check(approved.status === 200 && approved.data.preview?.canRestore === true, 'The identical archive can safely continue its interrupted configuration commit');
  let restore;
  progress('Committing the owner-approved migration exactly once');
  try { restore = await jsonRequest(target, '/zeta/api/backup/restore', { method: 'POST', json: { token: approved.data.token }, timeout: 60000 }); }
  catch (error) {
    // Never retry a mutating restore after HMR closes the original request.
    // A committed journal can be checked by a fresh request and restarted.
    const status = await waitFixture(target, value => value.migration?.status === 'complete').catch(() => undefined);
    if (!status) throw error;
    restore = { restored: true, restartRequired: true, acknowledgementInterruptedByReload: true };
  }
  check(restore.restored === true && restore.restartRequired === true, 'Restore commits its journal and requires a deliberate Host restart');
  const beforeRestart = await waitFixture(target, value => value.ready && value.migration?.status === 'complete');
  check(beforeRestart.modelCalls === 0 && beforeRestart.migration?.qqPaused === true, 'Restore itself remains paused and makes no target model request');
  await stop(target); await start(target);
  progress('Verifying cold restored data, original identities and paused tasks');
  cold = await jsonRequest(target, '/zeta-backup-fixture/verify', { method: 'POST', json: { expected: sourceReport }, timeout: 60000 });
  const duplicate = await preview(target, archive, PASSWORD);
  check(duplicate.status === 200 && duplicate.data.preview?.canRestore === false && duplicate.data.preview.conflicts.length > 0, 'Repeated import into an already restored environment reports native conflicts');
  const duplicateWrite = await request(target, '/zeta/api/backup/restore', { method: 'POST', json: { token: duplicate.data.token } });
  check(duplicateWrite.status === 400, 'Conflicting repeated restore cannot overwrite the restored environment');
  resumed = await jsonRequest(target, '/zeta-backup-fixture/resume', { method: 'POST', json: { expected: sourceReport }, timeout: 30000 });
  check(cold.modelCalls === 0 && resumed.modelCalls === 1 && resumed.fakeSends === 0, 'Target first stays cold, then continues one restored QQ turn using one local fixture call');
  progress('Activating the restored QQ configuration with a local SDK transport mock');
  const activation = await jsonRequest(target, '/zeta/api/backup/activate', { method: 'POST', json: {}, timeout: 30000 });
  check(activation.restartRequired === true, 'Explicit activation acknowledges the native configuration change');
  await waitFixture(target, value => value.ready && value.fakeStarts === 1 && value.migration?.qqPaused === false);
  activated = await jsonRequest(target, '/zeta-backup-fixture/activation', { method: 'POST', json: {} });
  const summary = { ok: true, pluginVersion, runtimeVersion: runtime.runtimeVersion, source: { sessions: sourceReport.sessions.length, schedules: sourceReport.schedules.length, modelCalls: sourceReport.modelCalls, checks: sourceReport.checks }, publicPlugin, checks, interruptedCommit: interrupted, targetCold: cold, targetResumed: resumed, targetActivated: activated, restoreAcknowledgementInterrupted: restore.acknowledgementInterruptedByReload === true };
  await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log(`Real two-computer migration passed: ${sourceReport.sessions.length} Sessions, ${sourceReport.schedules.length} tasks; target cold calls 0, resumed calls 1.`);
  console.log(`Isolated results: ${output}`);
} finally { await stop(source); await stop(target); }
