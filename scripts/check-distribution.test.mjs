import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkDistribution, moduleSpecifiers } from './check-distribution.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const checker = fileURLToPath(new URL('./check-distribution.mjs', import.meta.url));
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'zeta-dist-check-'));
  const manifest = { name: 'dsh-feiyu-zeta', version: 'fixture', main: './dist/index.js', types: './dist/index.d.ts', icon: './assets/icon.svg', exports: {
    '.': { types: './dist/index.d.ts', import: './dist/index.js' }, './client': { default: './lib/client.js' },
    './schedule-bridge': { types: './dist/bridge.d.ts', import: './dist/bridge.js' }, './locale/*.json': './locale/*.json',
  }, dsh: { bundle: { patch: './cordis.patch.yml' } } };
  const files = {
    'package.json': JSON.stringify(manifest), 'dist/index.d.ts': 'export {};', 'dist/index.js': "import './shared.js'; export * from './re-export.js'; await import('./dynamic.js'); require('./common.cjs');",
    'dist/shared.js': 'export const value = 1;', 'dist/re-export.js': "export { value } from './shared.js';", 'dist/dynamic.js': 'export {};', 'dist/common.cjs': 'module.exports = {};',
    'dist/bridge.js': 'export {};', 'dist/bridge.d.ts': 'export {};', 'lib/client.js': 'window.__ModuleLoader__.load({ id: "dsh-feiyu-zeta", factory: (require) => ({}) });',
    'assets/icon.svg': '<svg/>', 'cordis.patch.yml': "- insert:\n  - name: 'dsh-feiyu-zeta'\n  - name: 'dsh-feiyu-zeta/schedule-bridge'\n",
    'locale/zh.json': '{"meta":{"title":"dsh-feiyu-zeta"}}', 'locale/en.json': '{"meta":{"title":"dsh-feiyu-zeta"}}',
    'LICENSE': 'License fixture', 'THIRD_PARTY_NOTICES.md': 'Third party notices fixture', 'dist/licenses/dsh-meme-MIT.txt': 'MIT fixture',
  };
  try {
    for (const [name, value] of Object.entries(files)) { const path = join(root, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); }
    await cp(join(sourceRoot, 'vendor'), join(root, 'vendor'), { recursive: true });
    await run(root, manifest);
  } finally {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('zeta-dist-check-')) throw new Error('Invalid test cleanup boundary');
    await rm(root, { recursive: true, force: true });
  }
}

test('checks a standalone installed tree with no dependencies or plugin execution', async () => fixture(async root => {
  const result = await checkDistribution(root); assert.equal(result.bundledMemes, 24); assert.equal(result.relativeImports, 5);
  const cli = spawnSync(process.execPath, [checker, '--root', root], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.match(cli.stdout, /Distribution verified/);
}));
test('finds static, side-effect, re-export, dynamic, require and template-expression dependencies', () => {
  const source = [
    '/* import "./comment.js"; */ const text = "import(\'./example.js\')";',
    'const worker = `require("./worker-embedded.js")`;',
    'const nested = `value ${await import("./template-expression.js")} ${`nested ${1}`}`;',
    'import value from "./static.js"; import "./effect.js"; export * from "./export.js";',
    'await import("./dynamic.js"); require("./common.cjs"); require.resolve("./resolve.cjs");',
    String.raw`const pattern = /import\("\.\/regex\.js"\)/;`,
  ].join('\n');
  assert.deepEqual(moduleSpecifiers(source), ['./template-expression.js', './static.js', './effect.js', './export.js', './dynamic.js', './common.cjs', './resolve.cjs']);
  assert.throws(() => moduleSpecifiers('import(`./${name}.js`)'), /Computed module/);
  assert.throws(() => moduleSpecifiers('import(resolveModule())'), /Computed module/);
});
test('does not swallow real imports after arrow or statement regular expressions', () => {
  assert.deepEqual(moduleSpecifiers(String.raw`const f = () => /x\//; import './missing.js';`), ['./missing.js']);
  assert.deepEqual(moduleSpecifiers(String.raw`if (true) /x\//.test('x/'); import './missing.js';`), ['./missing.js']);
  assert.deepEqual(moduleSpecifiers(String.raw`if (true) {} else /x\//.test('x/'); import './missing.js';`), ['./missing.js']);
  assert.deepEqual(moduleSpecifiers("const n = ({ x: 1 }) / 2; import './missing.js';"), ['./missing.js']);
  assert.deepEqual(moduleSpecifiers("await import(('./wrapped.js')); await import('./options.json', { with: { type: 'json' } });"), ['./wrapped.js', './options.json']);
});
test('rejects a missing transitive dynamic import', async () => fixture(async root => {
  await rm(join(root, 'dist/dynamic.js')); await assert.rejects(checkDistribution(root), /dynamic\.js/);
}));
test('checks every conditional export leaf and wildcard match', async () => fixture(async (root, manifest) => {
  manifest.exports['.'].require = './dist/missing.cjs'; await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
  await assert.rejects(checkDistribution(root), /missing\.cjs/);
  delete manifest.exports['.'].require; manifest.exports['./missing/*'] = './missing/*.json'; await mkdir(join(root, 'missing')); await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
  await assert.rejects(checkDistribution(root), /Export pattern has no matching files/);
}));
test('requires the real top-level client registration to use the package id', async () => fixture(async root => {
  await writeFile(join(root, 'lib/client.js'), '// window.__ModuleLoader__.load({ id: "dsh-feiyu-zeta" });\nwindow.__ModuleLoader__.load({ id: "old-plugin", factory: () => ({}) });');
  await assert.rejects(checkDistribution(root), /ModuleLoader id/);
}));
test('rejects dependencies outside the distribution and incorrect path case', async () => fixture(async root => {
  await writeFile(join(root, 'dist/shared.js'), "import '../../outside.js';"); await assert.rejects(checkDistribution(root), /escapes distribution/);
  await writeFile(join(root, 'dist/shared.js'), "import './Dynamic.js';"); await assert.rejects(checkDistribution(root), /incorrect path case/);
}));
test('requires indexed meme originals and a readable database rather than loose image counts', async () => fixture(async root => {
  const pack = join(root, 'vendor/dsh-meme/memes/dafeiyu-001'), database = new DatabaseSync(join(pack, 'index.db'), { readOnly: true });
  let first; try { first = database.prepare('SELECT path FROM memes LIMIT 1').get().path; } finally { database.close(); }
  await rm(join(pack, first)); await assert.rejects(checkDistribution(root), /Missing file/);
  await writeFile(join(pack, 'index.db'), 'not a database'); await assert.rejects(checkDistribution(root), /not a SQLite database/);
}));
test('refuses an incomplete index even when all loose images are present', async () => fixture(async root => {
  const database = new DatabaseSync(join(root, 'vendor/dsh-meme/memes/dafeiyu-001/index.db'));
  try { database.exec('DELETE FROM memes WHERE rowid = (SELECT min(rowid) FROM memes)'); } finally { database.close(); }
  await assert.rejects(checkDistribution(root), /23\/24/);
}));
test('rejects installation hooks and required empty license files', async () => fixture(async (root, manifest) => {
  manifest.scripts = { prepare: 'npm run build' }; await writeFile(join(root, 'package.json'), JSON.stringify(manifest)); await assert.rejects(checkDistribution(root), /installation lifecycle/);
  delete manifest.scripts; await writeFile(join(root, 'package.json'), JSON.stringify(manifest)); await writeFile(join(root, 'LICENSE'), ''); await assert.rejects(checkDistribution(root), /empty distribution file/);
}));
test('does not modify the bundled SQLite database', async () => fixture(async root => {
  const path = join(root, 'vendor/dsh-meme/memes/dafeiyu-001/index.db'), before = await readFile(path);
  await checkDistribution(root); assert.deepEqual(await readFile(path), before);
}));
