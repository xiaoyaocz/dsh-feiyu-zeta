import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensurePackAt, openIndexWriter, type MemeRow } from '../../vendor/dsh-meme/memes.js';
import { safeArchiveName } from '../../vendor/dsh-meme/zip.js';

export interface MemeMigrationResult { imported: number; merged: number; alreadyMigrated: number }
function inside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}
function extension(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return '.png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return '.jpg';
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'))) return '.gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
  throw new Error('旧表情不是有效的PNG、JPEG、GIF或WebP图片；原图库已保留。');
}
const mergeWords = (...values: unknown[]) => [...new Set(values.flatMap(value => String(value || '').split(/[\s,，]+/u).filter(Boolean)))].join(' ');

/** Copy legacy collections without modifying their indexes or images. Row receipts also prevent deleted migrated images being resurrected. */
export async function migrateLegacyMemeCollections(dataDir: string, sharedRoot: string, maxImageBytes = 12 * 1024 * 1024): Promise<MemeMigrationResult> {
  const parent = resolve(dataDir, 'memes'), target = resolve(sharedRoot);
  await mkdir(target, { recursive: true });
  ensurePackAt(target, { id: 'collection', name: '共享表情库', description: 'dsh-feiyu-zeta shared collection' });
  const result: MemeMigrationResult = { imported: 0, merged: 0, alreadyMigrated: 0 };
  let directories;
  try { directories = await readdir(parent, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result; throw error; }
  const actualParent = await realpath(parent), actualTarget = await realpath(target);
  if (target !== parent && !inside(actualParent, actualTarget)) throw new Error('共享表情库位于预期目录之外。');
  await mkdir(join(target, 'memes'), { recursive: true });
  const imagesRoot = await realpath(join(target, 'memes'));
  if (!inside(actualTarget, imagesRoot)) throw new Error('共享表情图片目录越界。');
  const writer = openIndexWriter(target);
  try {
    writer.exec('CREATE TABLE IF NOT EXISTS zeta_legacy_sources (source TEXT NOT NULL, legacy_path TEXT NOT NULL, content_hash TEXT NOT NULL, metadata_json TEXT NOT NULL, PRIMARY KEY(source, legacy_path))');
    const receipt = writer.prepare('SELECT content_hash FROM zeta_legacy_sources WHERE source=? AND legacy_path=?');
    for (const directory of directories.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!directory.isDirectory() || !/^[a-f0-9]{32}$/i.test(directory.name)) continue;
      const legacy = await realpath(join(parent, directory.name));
      if (!inside(actualParent, legacy) || legacy === actualTarget) throw new Error('旧表情库路径越界，未修改原文件。');
      const indexFile = join(legacy, 'index.db');
      try { await stat(indexFile); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const index = new DatabaseSync(indexFile, { readOnly: true });
      let rows: MemeRow[];
      try {
        index.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF');
        const schema = index.prepare("SELECT type,sql FROM sqlite_schema WHERE name='memes'").get() as { type?: string; sql?: string } | undefined;
        if (schema?.type !== 'table' || !/^\s*CREATE\s+TABLE\b/iu.test(schema.sql || '')) throw new Error('旧表情索引不是普通数据表。');
        if ((index.prepare('PRAGMA table_xinfo(memes)').all() as Array<{ hidden?: number }>).some(column => column.hidden)) throw new Error('旧表情索引包含不支持的计算列。');
        rows = index.prepare("SELECT path,tag,file_name,caption,COALESCE(keywords,'') AS keywords,mtime,captioned_at FROM memes ORDER BY path LIMIT 100001").all() as unknown as MemeRow[];
        if (rows.length > 100000) throw new Error('旧表情索引过大，原图库已保留，请先整理。');
      } finally { index.close(); }
      for (const row of rows) {
        const oldPath = safeArchiveName(String(row.path));
        if (receipt.get(directory.name, oldPath)) { result.alreadyMigrated++; continue; }
        const file = await realpath(resolve(legacy, oldPath));
        if (!inside(legacy, file)) throw new Error('旧表情图片越界，原图库已保留。');
        const info = await stat(file);
        if (!info.isFile() || info.size < 1 || info.size > maxImageBytes) throw new Error('旧表情大小无效，原图库已保留。');
        const bytes = await readFile(file), hash = createHash('sha256').update(bytes).digest('hex');
        const imagePath = 'memes/' + hash + extension(bytes), destination = join(target, imagePath);
        let exists = false;
        try {
          const actual = await realpath(destination);
          if (!inside(imagesRoot, actual)) throw new Error('共享表情目标路径越界。');
          if (!(await readFile(actual)).equals(bytes)) throw new Error('共享表情哈希文件冲突，拒绝覆盖。');
          exists = true;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (!exists) {
          const temporary = join(imagesRoot, '.' + hash + '-' + randomUUID() + '.tmp');
          try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, destination); }
          finally { await unlink(temporary).catch(() => undefined); }
        }
        const existing = writer.prepare('SELECT caption,tag,file_name,keywords FROM memes WHERE path=?').get(imagePath) as { caption?: string; tag?: string; file_name?: string; keywords?: string } | undefined;
        const caption = String(row.caption || row.file_name || basename(oldPath));
        const mergedCaption = [...new Set([...(existing?.caption?.split(' / ') ?? []), caption])].filter(Boolean).join(' / ');
        // Keep original metadata verbatim in the receipt, including conflicting tags and captions.
        writer.exec('BEGIN IMMEDIATE');
        try {
          writer.prepare('INSERT OR REPLACE INTO memes(path,tag,file_name,caption,keywords,mtime,captioned_at) VALUES(?,?,?,?,?,?,?)')
            .run(imagePath, existing?.tag || String(row.tag || 'misc'), existing?.file_name || String(row.file_name || basename(oldPath)), mergedCaption,
              mergeWords(existing?.keywords, row.keywords, existing?.tag, row.tag), Number(row.mtime) || Date.now(), Number(row.captioned_at) || Date.now());
          writer.prepare('INSERT INTO zeta_legacy_sources(source,legacy_path,content_hash,metadata_json) VALUES(?,?,?,?)')
            .run(directory.name, oldPath, hash, JSON.stringify(row));
          writer.exec('COMMIT');
        } catch (error) { writer.exec('ROLLBACK'); throw error; }
        if (existing) result.merged++; else result.imported++;
      }
    }
    return result;
  } finally { writer.close(); }
}
