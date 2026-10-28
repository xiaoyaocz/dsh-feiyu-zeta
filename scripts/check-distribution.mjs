/** Read-only release checks. Uses Node built-ins and never loads plugin code. */
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const fail = message => { throw new Error(message); };
const slash = value => value.split(sep).join('/');
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

// Lex only code tokens: quoted examples/comments/Worker source must not become imports.
// Computed module specifiers cannot be resolved statically; literal specifiers are checked.
function tokens(source) {
  const result = [], parentheses = [], braces = []; let i = 0;
  const skipComment = () => {
    if (source.startsWith('//', i)) { i = source.indexOf('\n', i); if (i < 0) i = source.length; return true; }
    if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); if (end < 0) fail('Unterminated JavaScript comment'); i = end + 2; return true; }
    return false;
  };
  function quoted(quote) {
    let value = '', computed = false, closed = false; const expressions = []; i++;
    while (i < source.length) {
      const next = source[i++];
      if (next === quote) { closed = true; break; }
      if (quote === '`' && next === '$' && source[i] === '{') {
        computed = true; i++; const start = i; let depth = 1;
        while (i < source.length && depth) {
          if (skipComment()) continue;
          if (['"', "'", '`'].includes(source[i])) { quoted(source[i]); continue; }
          if (source[i] === '{') depth++;
          if (source[i] === '}') depth--;
          i++;
        }
        if (depth) fail('Unterminated JavaScript template expression');
        expressions.push(source.slice(start, i - 1));
        continue;
      }
      if (next !== '\\') { value += next; continue; }
      const escaped = source[i++];
      if (escaped === '\n') continue;
      if (escaped === '\r') { if (source[i] === '\n') i++; continue; }
      if (escaped === 'u' || escaped === 'x') {
        const length = escaped === 'u' ? 4 : 2; let hex;
        if (escaped === 'u' && source[i] === '{') { const end = source.indexOf('}', ++i); hex = source.slice(i, end); i = end + 1; }
        else { hex = source.slice(i, i + length); i += length; }
        if (!/^[\da-f]+$/iu.test(hex)) fail('Invalid JavaScript string escape');
        value += String.fromCodePoint(parseInt(hex, 16));
      } else value += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' })[escaped] ?? escaped;
    }
    if (!closed) fail('Unterminated JavaScript string');
    return { kind: computed ? 'computed' : 'string', value, expressions };
  }
  while (i < source.length) {
    const c = source[i];
    if (/\s/u.test(c)) { i++; continue; }
    if (skipComment()) continue;
    if (c === '"' || c === "'" || c === '`') { const token = quoted(c); result.push(token); for (const expression of token.expressions) result.push(...tokens(expression)); continue; }
    // Skip regex literals where an expression can begin; slash elsewhere is division.
    if (c === '/' && (!result.length || ['control-close', 'block-close'].includes(result.at(-1).kind) || /^(?:[=(:,[!&|?;{]|return|throw|case|else|do|yield|await|typeof|void|delete|in|of|instanceof|=>|&&|\|\||\?\?)$/u.test(result.at(-1).value))) {
      i++; let bracket = false, closed = false;
      while (i < source.length) { const next = source[i++]; if (next === '\\') { i++; continue; } if (next === '[') bracket = true; if (next === ']') bracket = false; if (next === '/' && !bracket) { closed = true; break; } if (/[\r\n]/u.test(next)) break; }
      if (!closed) fail('Unterminated JavaScript regular expression');
      while (/[a-z]/iu.test(source[i] ?? '') && i < source.length) i++;
      result.push({ kind: 'regex', value: '' }); continue;
    }
    if (/[\w$]/u.test(c)) { const start = i++; while (i < source.length && /[\w$]/u.test(source[i])) i++; result.push({ kind: 'word', value: source.slice(start, i) }); continue; }
    const pair = source.slice(i, i + 2);
    if (['=>', '&&', '||', '??', '?.', '++', '--'].includes(pair)) { result.push({ kind: 'punctuation', value: pair }); i += 2; continue; }
    if (c === '(') parentheses.push(['if', 'while', 'for', 'with', 'switch', 'catch'].includes(result.at(-1)?.value));
    if (c === '{') braces.push(!['=', '(', '[', ':', 'return', '?', ','].includes(result.at(-1)?.value));
    const kind = c === ')' && parentheses.pop() ? 'control-close' : c === '}' ? (braces.pop() ? 'block-close' : 'object-close') : 'punctuation';
    result.push({ kind, value: c }); i++;
  }
  return result;
}

export function moduleSpecifiers(source) {
  const code = tokens(source), found = [];
  for (let i = 0; i < code.length; i++) {
    const current = code[i]; if (current.kind !== 'word' || !['import', 'export', 'require'].includes(current.value) || code[i - 1]?.value === '.') continue;
    let next = i + 1;
    if (current.value === 'import' && code[next]?.value === '.') continue;
    if (current.value === 'require' && code[next]?.value === '.' && code[next + 1]?.value === 'resolve') next += 2;
    if (code[next]?.value === '(') {
      let literal = next + 1, wrapped = 0;
      while (code[literal]?.value === '(') { literal++; wrapped++; }
      const specifier = code[literal++];
      while (wrapped && code[literal]?.value === ')') { literal++; wrapped--; }
      if (specifier?.kind === 'string' && !wrapped && [')', ','].includes(code[literal]?.value)) found.push(specifier.value);
      else fail('Computed module specifier cannot be verified; use a literal import or require');
    } else if (current.value === 'import' && code[next]?.kind === 'string') found.push(code[next].value);
    else if (current.value !== 'require') {
      for (let j = next; j < code.length && code[j].value !== ';'; j++) {
        if (code[j].kind === 'word' && code[j].value === 'from' && code[j + 1]?.kind === 'string') { found.push(code[j + 1].value); break; }
      }
    }
  }
  return [...new Set(found)];
}

function checkLockfile(lock, manifest) {
  if (!lock || ![2, 3].includes(lock.lockfileVersion) || !lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) fail('Invalid npm lockfile packages');
  const root = lock.packages[''];
  if (lock.name !== manifest.name || lock.version !== manifest.version || root?.name !== manifest.name || root?.version !== manifest.version) fail('npm lockfile name/version differs from package.json');
  const normalized = value => { try { return decodeURIComponent(value).replaceAll('\\', '/'); } catch { fail('Invalid npm lockfile path encoding'); } };
  for (const [path, record] of Object.entries(lock.packages)) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) fail(`Invalid npm lockfile package: ${path}`);
    if (record.link === true) fail(`npm lockfile contains a non-portable link: ${path}`);
    const location = normalized(path);
    if (/(?:^|\/)\.pnpm(?:\/|$)/iu.test(location)) fail(`npm lockfile references a local .pnpm store: ${path}`);
    if (location && (!location.startsWith('node_modules/') || location.split('/').some(part => part === '..' || part === '.'))) fail(`npm lockfile references local source: ${path}`);
    if (record.resolved === undefined) continue;
    if (typeof record.resolved !== 'string') fail(`Invalid npm lockfile resolved value: ${path}`);
    const resolved = normalized(record.resolved);
    if (/(?:^|\/)\.pnpm(?:\/|$)/iu.test(resolved)) fail(`npm lockfile references a local .pnpm store: ${path}`);
    // Registry URLs and Git URLs (including scp-style Git SSH) remain valid.
    if (/^(?:git\+)?(?:file|link|workspace):/iu.test(resolved) || !(/^(?:https?:|git(?:\+https?|\+ssh)?:|ssh:|github:|gitlab:|bitbucket:)/iu.test(resolved) || /^[\w.-]+@[^/:]+:.+/u.test(resolved))) fail(`npm lockfile resolved dependency uses local source: ${path}`);
  }
}

export async function checkDistribution(directory) {
  const root = await realpath(resolve(directory)), checked = new Set();
  const inside = value => { const path = relative(root, value); return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path); };
  const localPath = value => {
    if (typeof value !== 'string' || !value || /[\\\0]/u.test(value) || isAbsolute(value)) fail(`Invalid distribution path: ${value}`);
    const path = resolve(root, value); if (!inside(path)) fail(`Path escapes distribution: ${value}`); return path;
  };
  async function file(value) {
    const path = localPath(value), parts = relative(root, path).split(sep); let current = root;
    for (const part of parts) {
      const names = await readdir(current);
      if (!names.includes(part)) fail(`Missing file or incorrect path case: ${value}`);
      current = resolve(current, part); if ((await lstat(current)).isSymbolicLink()) fail(`Symlink is not a portable distribution file: ${value}`);
    }
    const info = await lstat(path); if (!info.isFile() || !info.size) fail(`Missing or empty distribution file: ${value}`);
    checked.add(slash(relative(root, path))); return path;
  }
  async function walk(value) {
    const directory = localPath(value), files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = slash(relative(root, resolve(directory, entry.name)));
      if (entry.isSymbolicLink()) fail(`Symlink is not a portable distribution file: ${path}`);
      if (entry.isDirectory()) files.push(...await walk(path)); else if (entry.isFile()) files.push(path);
    }
    return files.sort();
  }
  const manifest = JSON.parse(await readFile(await file('package.json'), 'utf8'));
  if (typeof manifest.name !== 'string' || !manifest.name) fail('Package name is missing');
  const lockfile = (await readdir(root)).some(name => name.toLowerCase() === 'package-lock.json');
  if (lockfile) checkLockfile(JSON.parse(await readFile(await file('package-lock.json'), 'utf8')), manifest);
  for (const hook of ['prepare', 'preinstall', 'install', 'postinstall']) if (manifest.scripts?.[hook]) fail(`Distribution must not require an installation lifecycle: ${hook}`);
  for (const key of ['main', 'types', 'icon']) await file(manifest[key]);
  async function exportsExist(value) {
    if (value === null) return;
    if (typeof value === 'string') {
      if (!value.startsWith('./')) fail(`Export must use a package-relative target: ${value}`);
      if (!value.includes('*')) { await file(value); return; }
      localPath(value);
      const prefix = value.slice(0, value.indexOf('*')), directory = prefix.slice(0, prefix.lastIndexOf('/')) || '.';
      const pattern = new RegExp(`^${value.replace(/^\.\//u, '').split('*').map(escapeRegex).join('.*')}$`, 'u');
      const matches = (await walk(directory)).filter(path => pattern.test(path));
      if (!matches.length) fail(`Export pattern has no matching files: ${value}`);
      for (const match of matches) await file(match);
      return;
    }
    if (!value || typeof value !== 'object') fail('Invalid package exports');
    for (const item of Object.values(value)) await exportsExist(item);
  }
  if (!manifest.exports?.['.'] || !manifest.exports?.['./client'] || !manifest.exports?.['./schedule-bridge']) fail('Host, client and schedule-bridge exports are required');
  await exportsExist(manifest.exports);
  const clientTarget = manifest.exports['./client'].default;
  const client = tokens(await readFile(await file(clientTarget), 'utf8'));
  const header = ['window', '.', '__ModuleLoader__', '.', 'load', '(', '{', 'id', ':'];
  if (!header.every((value, index) => client[index]?.value === value) || client[header.length]?.kind !== 'string' || client[header.length].value !== manifest.name) fail('Client ModuleLoader id does not match the package name');
  const patch = await readFile(await file(manifest.dsh?.bundle?.patch), 'utf8');
  for (const name of [manifest.name, `${manifest.name}/schedule-bridge`]) if (!new RegExp(`^\\s+(?:-\\s*)?name:\\s*['"]?${escapeRegex(name)}['"]?\\s*$`, 'mu').test(patch)) fail(`Bundle patch is missing ${name}`);
  for (const language of ['zh', 'en']) {
    const locale = JSON.parse(await readFile(await file(`locale/${language}.json`), 'utf8'));
    if (locale.meta?.title !== manifest.name) fail(`Plugin card name differs in locale/${language}.json`);
  }
  for (const path of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'vendor/dsh-meme/LICENSE', 'dist/licenses/dsh-meme-MIT.txt', 'vendor/dsh-meme/memes.js', 'vendor/dsh-meme/zip.js']) await file(path);
  const pack = 'vendor/dsh-meme/memes/dafeiyu-001';
  const packManifest = JSON.parse(await readFile(await file(`${pack}/manifest.json`), 'utf8'));
  if (packManifest.id !== 'dafeiyu-001') fail('Bundled meme manifest has the wrong pack id');
  const databasePath = await file(`${pack}/index.db`);
  if (!(await readFile(databasePath)).subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) fail('Bundled meme index is not a SQLite database');
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(databasePath, { readOnly: true }); let rows;
  try { rows = database.prepare('SELECT path FROM memes').all(); } finally { database.close(); }
  if (rows.length < 24) fail(`Bundled meme index has only ${rows.length}/24 images`);
  for (const row of rows) {
    if (typeof row.path !== 'string' || !row.path.startsWith('memes/') || !/\.(?:png|jpe?g|gif|webp)$/iu.test(row.path)) fail('Invalid bundled meme image path');
    const path = `${pack}/${row.path}`; if (!localPath(path).startsWith(`${localPath(pack)}${sep}`)) fail('Meme image escapes its pack'); await file(path);
  }
  let jsFiles = 0, relativeImports = 0;
  for (const directory of ['dist', 'lib', 'vendor']) for (const path of await walk(directory)) {
    if (!/\.(?:c|m)?js$/u.test(path)) continue;
    jsFiles++; const absolute = await file(path);
    let specifiers; try { specifiers = moduleSpecifiers(await readFile(absolute, 'utf8')); } catch (error) { fail(`${path}: ${error.message}`); }
    for (const specifier of specifiers) if (specifier.startsWith('.')) {
      if (/[\\\0]/u.test(specifier)) fail(`Invalid relative dependency in ${path}`);
      const target = resolve(dirname(absolute), decodeURIComponent(specifier.split(/[?#]/u)[0]));
      if (!inside(target)) fail(`Relative dependency escapes distribution: ${path} -> ${specifier}`);
      if (/\.(?:tsx?|jsx)$/u.test(extname(target))) fail(`Uncompiled dependency: ${path} -> ${specifier}`);
      await file(slash(relative(root, target))); relativeImports++;
    }
  }
  return { name: manifest.name, version: manifest.version, files: checked.size, jsFiles, relativeImports, bundledMemes: rows.length, lockfile };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--root' || !args[1])) fail('Usage: node scripts/check-distribution.mjs [--root <directory>]');
    const result = await checkDistribution(args[1] ?? fileURLToPath(new URL('../', import.meta.url)));
    console.log(`Distribution verified: ${JSON.stringify(result)}`);
  } catch (error) { console.error(`Distribution check failed: ${error.message}`); process.exitCode = 1; }
}
