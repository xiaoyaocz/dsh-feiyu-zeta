#!/usr/bin/env node
// Runs the installed Desktop's real DSH Web Host twice in an isolated home.
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, readdir, writeFile, access } from 'node:fs/promises';
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
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--help') { console.log('node scripts/verify-host.mjs (--package <local.tgz> [--upgrade-from <same-package-legacy.tgz>] | --spec <github:owner/repo#commit-or-git-URL>) [--expected-name <package>] [--expected-version <version>] [--offline] [--desktop-exe <path>] [--output <new-directory>] [--inspect-only]'); process.exit(0); }
  if (args[i] === '--inspect-only') options.inspectOnly = true;
  else if (args[i] === '--offline') options.offline = true;
  else if (['--package', '--spec', '--upgrade-from', '--expected-name', '--expected-version', '--desktop-exe', '--output'].includes(args[i]) && args[i + 1]) options[args[i].slice(2)] = args[++i];
  else throw new Error(`Unknown or incomplete option: ${args[i]}`);
}
const pluginVersion = options['expected-version'] || packageMetadata.version;
const pluginName = options['expected-name'] || packageMetadata.name;
if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u.test(pluginName)) throw new Error('--expected-name must be an npm package name');
if (options.package && options.spec) throw new Error('--package and --spec are mutually exclusive');
if (options.spec && options['upgrade-from']) throw new Error('--upgrade-from requires --package; Git installation uses two clean/restart phases');
if (options.spec) {
  const spec = options.spec;
  if (/\s|\?/u.test(spec) || spec.startsWith('-')) throw new Error('--spec must be a Git repository spec without credentials, query strings or whitespace');
  if (!/^github:[^/#]+\/[^/#]+(?:#.*)?$/u.test(spec) && !/^git@github\.com:[^/]+\/[^#]+(?:#.*)?$/u.test(spec)) {
    const url = new URL(spec.replace(/^git\+/u, ''));
    if (!['https:', 'http:', 'ssh:', 'file:'].includes(url.protocol) || url.username || url.password || (url.protocol === 'file:' && !spec.startsWith('git+file:')))
      throw new Error('--spec must name a Git repository; use github:owner/repo#commit or git+https://host/owner/repo.git#commit (git+file: is supported for isolated fixtures)');
  }
}
const runtime = discover(options['desktop-exe']);
if (options.inspectOnly) { console.log(JSON.stringify({ ...runtime, testProfile: 'web', modifiesExistingProfiles: false }, null, 2)); process.exit(0); }
if (!options.package && !options.spec) throw new Error('Provide --package <built-local.tgz> or --spec <Git-repository-spec>');
const packageFile = options.package ? resolve(options.package) : undefined;
if (packageFile) await access(packageFile);
const installSpec = options.spec || packageFile;
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
// Real native Web tools use only the probe's offline providers in this home.
environment.DSH_WEB_SEARCH_PROVIDER = 'zeta-native-life-fixture';
environment.DSH_WEB_FETCH_PROVIDER = 'zeta-native-life-fixture';
environment.GIT_TERMINAL_PROMPT = '0';
environment.GCM_INTERACTIVE = 'Never';
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
const installChecks = [];
const artifactCheck = (condition, description) => { if (!condition) throw new Error(description); installChecks.push(description); };
let installationLog = '';
async function installPackage(spec, label) {
  const install = launch(['plugin', '--profile', 'web', 'add', spec, ...options.offline ? ['--offline'] : []], label);
  const installStatus = await install.exited;
  installationLog = install.log();
  await writeFile(join(output, `${label}.log`), redactLog(install.log()), 'utf8');
  if (installStatus.code !== 0) throw new Error(`Isolated official CLI installation failed (${installStatus.code}); see ${join(output, `${label}.log`)}`);
}
async function inspectInstalledArtifacts(expectedVersion) {
  const packageRoot = join(home, 'profiles', 'web', 'node_modules', pluginName);
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  artifactCheck(manifest.name === pluginName && manifest.version === expectedVersion, 'Installed manifest has the expected package name and version');
  const artifactPath = async value => {
    if (typeof value !== 'string' || !value.startsWith('./')) throw new Error(`Installed artifact is not package relative: ${value}`);
    const path = resolve(packageRoot, value), rel = relative(packageRoot, path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error(`Installed artifact leaves its package: ${value}`);
    await access(path); return path;
  };
  const exportPath = value => typeof value === 'string' ? value : value?.import ?? value?.default;
  const hostEntry = exportPath(manifest.exports?.['.']) ?? manifest.main;
  await artifactPath(hostEntry); await artifactPath(manifest.main);
  await artifactPath(exportPath(manifest.exports?.['./schedule-bridge']));
  artifactCheck(true, 'Installed host root and schedule bridge resolve to shipped built files');
  const declaredPatches = manifest.dsh?.bundle?.patch;
  const bundlePatches = typeof declaredPatches === 'string' ? [declaredPatches] : declaredPatches;
  artifactCheck(Array.isArray(bundlePatches) && bundlePatches.length > 0, 'Installed package declares its own DSH bundle patch');
  for (const patch of bundlePatches) await artifactPath(patch);
  const profile = JSON.parse(await readFile(join(home, 'profiles', 'web', 'package.json'), 'utf8'));
  artifactCheck(profile.dsh?.profile?.bundles?.includes(pluginName) && Object.hasOwn(profile.dependencies ?? {}, pluginName), 'Official CLI records and activates the installed bundle in the isolated profile');
  let resolvedSource;
  try { resolvedSource = require('yaml').parse(await readFile(join(home, 'profiles', 'web', 'pnpm-lock.yaml'), 'utf8'))?.importers?.['.']?.dependencies?.[pluginName]; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const expectedCommit = options.spec ? /#([a-f0-9]{40})$/iu.exec(options.spec)?.[1]?.toLowerCase() : undefined;
  if (options.spec) artifactCheck(typeof resolvedSource?.version === 'string' && (!expectedCommit || resolvedSource.version.toLowerCase().includes(expectedCommit)), 'Git lockfile records the installed source and the requested exact commit when pinned');
  const clientEntry = exportPath(manifest.exports?.['./client']);
  artifactCheck(manifest.dsh?.client?.platform === 'web', 'Installed package declares its Web client half');
  const client = await readFile(await artifactPath(clientEntry), 'utf8');
  const clientId = /__ModuleLoader__\.load\(\{\s*id:\s*("(?:[^"\\]|\\.)*")/u.exec(client)?.[1];
  artifactCheck(clientId !== undefined && JSON.parse(clientId) === pluginName, 'Shipped client bundle registers the exact installed package module ID');
  await artifactPath(manifest.exports?.['./package.json']);
  for (const locale of ['en', 'zh']) {
    const pattern = manifest.exports?.['./locale/*.json'];
    const path = await artifactPath(typeof pattern === 'string' ? pattern.replace('*', locale) : undefined);
    artifactCheck(JSON.parse(await readFile(path, 'utf8')).meta?.title === pluginName, `Installed ${locale} display metadata is exported and readable`);
  }
  await artifactPath(manifest.icon);
  const peerDependencies = Object.fromEntries(Object.entries(manifest.peerDependencies ?? {}).filter(([name]) => name.startsWith('@deepseek-ai/')));
  artifactCheck(['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-storage-domain'].every(name => typeof peerDependencies[name] === 'string'), 'Installed package retains shared Host peer dependency declarations');
  for (const path of ['./vendor/dsh-meme/memes.js', './vendor/dsh-meme/zip.js', './vendor/dsh-meme/LICENSE', './vendor/dsh-meme/memes/dafeiyu-001/index.db', './vendor/dsh-meme/memes/dafeiyu-001/manifest.json']) await artifactPath(path);
  let memeImageCount = 0;
  async function countImages(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await countImages(join(path, entry.name));
      else if (entry.isFile() && /\.(?:png|jpe?g|gif|webp)$/iu.test(entry.name)) memeImageCount++;
    }
  }
  await countImages(join(packageRoot, 'vendor', 'dsh-meme', 'memes'));
  artifactCheck(memeImageCount >= 24, 'Installed vendor runtime, index, license and at least 24 built-in meme images are present');
  const installLifecycleHooks = ['preinstall', 'install', 'postinstall', 'prepare'].filter(name => manifest.scripts?.[name]);
  let approvedBuildKeys = [];
  try { const policy = require('yaml').parse(await readFile(join(home, 'profiles', 'web', 'pnpm-workspace.yaml'), 'utf8')); approvedBuildKeys = Object.entries(policy?.allowBuilds ?? {}).filter(([, value]) => value === true).map(([name]) => name); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (options.spec) artifactCheck(installLifecycleHooks.length === 0 && approvedBuildKeys.length === 0 && !/GIT_DEP_PREPARE_NOT_ALLOWED|ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/u.test(installationLog), 'Git installation succeeds using prebuilt artifacts without lifecycle hooks or build-script approval');
  return { name: manifest.name, version: manifest.version, source: profile.dependencies[pluginName], resolvedSource, hostEntry, clientEntry, clientModuleId: clientId ? JSON.parse(clientId) : null, bundlePatches, peerDependencies, memeImageCount, installLifecycleHooks, approvedBuildKeys };
}
await installPackage(legacyPackage || installSpec, 'install');
const results = [];
let installedArtifacts;
for (const phase of legacyPackage ? [0, 1, 2] : [1, 2]) {
  if (phase === 1 && legacyPackage) await installPackage(packageFile, 'upgrade');
  const installedVersion = JSON.parse(await readFile(join(home, 'profiles', 'web', 'node_modules', pluginName, 'package.json'), 'utf8')).version;
  if (phase !== 0 && installedVersion !== pluginVersion) throw new Error(`Expected freshly built ${pluginVersion}, but installed package is ${installedVersion}; rebuild and pack before verification.`);
  if (phase === 1) installedArtifacts = await inspectInstalledArtifacts(pluginVersion);
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
    { id: 'web', config: { searchProvider: 'zeta-native-life-fixture', fetchProvider: 'zeta-native-life-fixture' } },
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
await writeFile(join(output, 'summary.json'), JSON.stringify({ ok: true, pluginVersion, runtimeVersion: runtime.runtimeVersion, home, ...(packageFile ? { package: packageFile } : { spec: options.spec }), offline: options.offline === true, installedArtifacts, ...(legacyPackage ? { upgradedFrom: legacyPackage } : {}), checks: [...installChecks, ...results.flatMap(result => result.checks)], phases: results }, null, 2), 'utf8');
console.log(`Real Host verification passed. Isolated results: ${output}`);
