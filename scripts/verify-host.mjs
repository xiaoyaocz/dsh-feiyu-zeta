#!/usr/bin/env node
// Runs the installed Desktop's real DSH Web Host twice in an isolated home.
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { discover } = require('./inspect-local-runtime.cjs');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageMetadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const pluginVersion = packageMetadata.version;
const pluginName = packageMetadata.name;
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--help') { console.log('node scripts/verify-host.mjs --package <local.tgz> [--upgrade-from <same-package-legacy.tgz>] [--desktop-exe <path>] [--output <new-directory>] [--inspect-only]'); process.exit(0); }
  if (args[i] === '--inspect-only') options.inspectOnly = true;
  else if (['--package', '--upgrade-from', '--desktop-exe', '--output'].includes(args[i]) && args[i + 1]) options[args[i].slice(2)] = args[++i];
  else throw new Error(`Unknown or incomplete option: ${args[i]}`);
}
const runtime = discover(options['desktop-exe']);
if (options.inspectOnly) { console.log(JSON.stringify({ ...runtime, testProfile: 'web', modifiesExistingProfiles: false }, null, 2)); process.exit(0); }
if (!options.package) throw new Error('--package must name the built local plugin .tgz');
const packageFile = resolve(options.package);
await access(packageFile);
const legacyPackage = options['upgrade-from'] ? resolve(options['upgrade-from']) : undefined;
if (legacyPackage) {
  await access(legacyPackage);
  const extract = require('tar-stream').extract();
  let legacyManifest;
  extract.on('entry', (header, stream, next) => {
    if (header.name !== 'package/package.json') { stream.resume(); stream.once('end', next); return; }
    if (header.size > 1024 * 1024) { extract.destroy(new Error('Legacy package manifest is too large')); return; }
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.once('end', () => {
      try { legacyManifest = JSON.parse(Buffer.concat(chunks).toString('utf8')); next(); }
      catch { extract.destroy(new Error('Legacy package manifest is invalid')); }
    });
  });
  await pipeline(createReadStream(legacyPackage), createGunzip(), extract);
  if (legacyManifest?.name !== pluginName) throw new Error(`--upgrade-from supports earlier ${pluginName} archives only. For a former package name, use the encrypted backup migration workflow and verify-backup-host.mjs.`);
}
const output = resolve(options.output || join(root, 'output', `host-verification-${new Date().toISOString().replace(/[:.]/g, '-')}`));
// Creating a fresh directory is intentional: never adopt or overwrite an existing DSH home.
await mkdir(output, { recursive: false });
const home = join(output, 'home');
const workspace = join(output, 'workspace');
await mkdir(home); await mkdir(workspace);
const environment = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_TOOLS_MODE: 'native', DSH_PERMISSION_MODE: 'workspace-write' };
for (const key of Object.keys(environment)) {
  if (/API[_-]?KEY|TOKEN|SECRET|PASSWORD|QQBOT|DEEPSEEK[_-]AUTH/i.test(key)) delete environment[key];
}
// The isolated profile does not load ambient project/user credential fallback files.
environment.HOME = workspace; environment.USERPROFILE = workspace;
function launch(cliArgs, label) {
  const child = spawn(runtime.executable, [runtime.cliPath, ...cliArgs], { cwd: workspace, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', data => { log = (log + data.toString()).slice(-200000); });
  child.stderr.on('data', data => { log = (log + data.toString()).slice(-200000); });
  child.on('error', error => { log += `\n${error.message}`; });
  const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));
  return { child, exited, log: () => log, label };
}
const redactLog = value => value.replace(/([?&]token=)[^&\s"']+/g, '$1[redacted]');
async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const port = server.address().port;
  await new Promise(resolveClose => server.close(resolveClose)); return port;
}
async function installPackage(file, label) {
  const install = launch(['plugin', '--profile', 'web', 'add', file], label);
  const installStatus = await install.exited;
  await writeFile(join(output, `${label}.log`), redactLog(install.log()), 'utf8');
  if (installStatus.code !== 0) throw new Error(`Isolated official CLI installation failed (${installStatus.code}); see ${join(output, `${label}.log`)}`);
}
await installPackage(legacyPackage || packageFile, 'install');
const results = [];
for (const phase of legacyPackage ? [0, 1, 2] : [1, 2]) {
  if (phase === 1 && legacyPackage) await installPackage(packageFile, 'upgrade');
  const installedVersion = JSON.parse(await readFile(join(home, 'profiles', 'web', 'node_modules', pluginName, 'package.json'), 'utf8')).version;
  if (phase !== 0 && installedVersion !== pluginVersion) throw new Error(`Expected freshly built ${pluginVersion}, but installed package is ${installedVersion}; rebuild and pack before verification.`);
  const port = await freePort();
  const resultFile = join(output, `phase-${phase}.json`);
  const fixture = join(root, 'scripts', 'fixtures', 'host-probe.mjs');
  // JSON is valid YAML. Patch rows replace whole config objects in rc.3.
  const patch = [
    { id: 'hmr', disabled: true },
    { id: 'session-title-llm', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'agent-default-model', config: { provider: 'zeta-host-fixture', model: 'fixture' } },
    { id: 'tools', config: { mode: 'native' } },
    { id: 'webserver', config: { host: '127.0.0.1', port, compression: 'none' } },
    { id: 'web-runtime', config: { openBrowser: false, printUrl: true, surfaceContext: true } },
    { id: 'im-qqbot', config: { appId: 'zeta-fixture', appSecret: 'unused-local-fixture', zeta: { connectQQ: false, dataDir: join(output, 'media') } } },
    { insert: [{ id: 'zeta-host-verification', name: fixture, config: { phase, port, workspace, expectedVersion: phase === 0 ? installedVersion : pluginVersion, moduleRoot: runtime.moduleRoot, pluginRoot: join(home, 'profiles', 'web', 'node_modules', pluginName), resultFile, stateFile: join(output, 'persistent-probe.json'), legacyFile: legacyPackage ? join(output, 'legacy-probe.json') : undefined } }] },
  ];
  const patchFile = join(output, `phase-${phase}.patch.yml`);
  await writeFile(patchFile, JSON.stringify(patch, null, 2), 'utf8');
  const host = launch(['--profile', 'web', '--patch', patchFile], `phase-${phase}`);
  let result;
  try {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      try { result = JSON.parse(await readFile(resultFile, 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      if (host.child.exitCode !== null) throw new Error(`Host exited early (${host.child.exitCode})`);
      await delay(200);
    }
    if (!result) throw new Error('Timed out waiting for the real Host probe');
  } finally {
    // The fixture already awaited durable writes. Restart also exercises recovery
    // after process termination, without touching the user's running Desktop.
    host.child.kill();
    await host.exited;
    await writeFile(join(output, `phase-${phase}.log`), redactLog(host.log()), 'utf8');
  }
  results.push(result);
  if (!result.ok) throw new Error(`Real Host phase ${phase} failed: ${result.error}; results: ${resultFile}`);
  console.log(`Real Host phase ${phase}: ${result.checks.length} checks passed (${result.modelCalls} local fixture calls).`);
}
await writeFile(join(output, 'summary.json'), JSON.stringify({ ok: true, pluginVersion, runtimeVersion: runtime.runtimeVersion, home, package: packageFile, ...(legacyPackage ? { upgradedFrom: legacyPackage } : {}), checks: results.flatMap(result => result.checks), phases: results }, null, 2), 'utf8');
console.log(`Real Host verification passed. Isolated results: ${output}`);
