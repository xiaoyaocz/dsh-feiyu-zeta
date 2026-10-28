#!/usr/bin/env node
'use strict';

// Read-only discovery. Electron's bundled DSH lives inside app.asar, while an
// older Desktop-generated dsh shim may still point at a removed runtime.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function readAsarFile(archive, relative) {
  const fd = fs.openSync(archive, 'r');
  try {
    const prefix = Buffer.alloc(16);
    if (fs.readSync(fd, prefix, 0, 16, 0) !== 16) throw new Error('Invalid ASAR header');
    const headerSize = prefix.readUInt32LE(4);
    const jsonSize = prefix.readUInt32LE(12);
    if (jsonSize < 2 || jsonSize > 128 * 1024 * 1024 || headerSize < jsonSize) {
      throw new Error('Invalid ASAR header size');
    }
    const json = Buffer.alloc(jsonSize);
    if (fs.readSync(fd, json, 0, jsonSize, 16) !== jsonSize) throw new Error('Incomplete ASAR header');
    const header = JSON.parse(json.toString('utf8'));
    let normalized = relative.replace(/\\/g, '/');
    let entry;
    for (let links = 0; links < 16; links++) {
      entry = header;
      for (const component of normalized.split('/')) {
        if (!component || component === '.' || component === '..') throw new Error('Invalid ASAR path');
        entry = entry.files?.[component];
        if (!entry) throw new Error(`Bundled file not found: ${relative}`);
      }
      if (!entry.link) break;
      normalized = entry.link.replace(/\\/g, '/');
      if (links === 15) throw new Error('ASAR link cycle');
    }
    if (entry.files) throw new Error('Expected an ASAR file');
    if (entry.unpacked) return fs.readFileSync(path.join(`${archive}.unpacked`, ...normalized.split('/')));
    const size = Number(entry.size);
    const offset = 8 + headerSize + Number(entry.offset);
    if (!Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024 || !Number.isSafeInteger(offset)) {
      throw new Error('Invalid bundled file extent');
    }
    const content = Buffer.alloc(size);
    if (fs.readSync(fd, content, 0, size, offset) !== size) throw new Error('Incomplete bundled file');
    return content;
  } finally {
    fs.closeSync(fd);
  }
}

function discover(explicitExecutable) {
  const candidates = [
    explicitExecutable,
    process.env.DSH_DESKTOP_EXE,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'DeepSeek Harness', 'DeepSeek Harness.exe'),
  ].filter(Boolean);
  const failures = [];
  for (const candidate of [...new Set(candidates.map(p => path.resolve(p)))]) {
    if (!fs.existsSync(candidate)) continue;
    const archive = path.join(path.dirname(candidate), 'resources', 'app.asar');
    try {
      const manifest = relative => JSON.parse(readAsarFile(archive, relative).toString('utf8'));
      const desktop = manifest('package.json');
      const moduleRoot = 'dsh/node_modules/@deepseek-ai';
      const dsh = manifest(`${moduleRoot}/dsh/package.json`);
      const cliRelative = `${moduleRoot}/dsh/${typeof dsh.bin === 'string' ? dsh.bin : dsh.bin.dsh}`;
      readAsarFile(archive, cliRelative);
      const versionOf = name => {
        try { return manifest(`${moduleRoot}/${name}/package.json`).version; }
        catch { return null; }
      };
      return {
        executable: candidate,
        archive,
        cliPath: path.join(archive, ...cliRelative.split('/')),
        moduleRoot: path.join(archive, ...moduleRoot.split('/')),
        desktopVersion: desktop.version,
        runtimeVersion: dsh.version,
        cordisVersion: versionOf('cordis'),
        schemasteryVersion: versionOf('schemastery'),
        needsElectronNode: true,
        harnessHome: path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh')),
      };
    } catch (error) {
      failures.push(`${candidate}: ${error.message}`);
    }
  }
  throw new Error('Cannot locate a readable DeepSeek Harness Desktop runtime. Pass --desktop-exe <path>.' +
    (failures.length ? ` ${failures.join('; ')}` : ''));
}

module.exports = { discover, readAsarFile };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
      process.stdout.write('Read-only DSH runtime inspection: node scripts/inspect-local-runtime.cjs [--desktop-exe <path>]\n');
    } else {
      let executable;
      for (let i = 0; i < args.length; i++) {
        if (args[i] !== '--desktop-exe' || !args[i + 1]) throw new Error(`Unknown or incomplete argument: ${args[i]}`);
        executable = args[++i];
      }
      process.stdout.write(`${JSON.stringify(discover(executable), null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`DSH runtime inspection failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
