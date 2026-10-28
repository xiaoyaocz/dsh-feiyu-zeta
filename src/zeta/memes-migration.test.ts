import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensurePackAt, openIndexWriter } from '../../vendor/dsh-meme/memes.js';
import { migrateLegacyMemeCollections, MemeModule } from './memes.ts';
import type { ModuleHost } from './contracts.ts';

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zeta-meme-migrate-')); roots.push(root);
  const shared = join(root, 'memes', 'shared');
  const host = { dataDir: root, bindingFor: () => ({ key: 'trusted' }), isLifeAgent: () => false, directoryFor: async () => shared } as unknown as ModuleHost;
  async function seed(space: string, bytes: Buffer, caption: string, tag: string, keywords: string, fileName = 'image.gif') {
    const legacy = join(root, 'memes', createHash('sha256').update(space).digest('hex').slice(0, 32));
    await mkdir(legacy, { recursive: true });
    ensurePackAt(legacy, { id: 'collection', name: 'old', description: 'old' });
    await writeFile(join(legacy, fileName), bytes);
    const db = openIndexWriter(legacy);
    try { db.prepare('INSERT OR REPLACE INTO memes(path,tag,file_name,caption,keywords) VALUES(?,?,?,?,?)').run(fileName, tag, fileName, caption, keywords); }
    finally { db.close(); }
    return legacy;
  }
  return { root, shared, host, seed };
}

describe('legacy shared meme migration', () => {
  it('merges byte-identical images and metadata from every old space while preserving GIF and originals', async () => {
    const f = await fixture();
    const a = await f.seed('a', GIF, '开心动图', 'happy', '庆祝 开心');
    const b = await f.seed('b', GIF, '点头赞同', 'like', '赞同 点头');
    const result = await migrateLegacyMemeCollections(f.root, f.shared);
    expect(result).toEqual({ imported: 1, merged: 1, alreadyMigrated: 0 });
    const module = new MemeModule(f.host);
    const listing = await module.list({}, { query: '赞同', limit: 50 });
    expect(listing.items).toHaveLength(1);
    expect(listing.items[0]!.caption).toContain('开心动图');
    expect(listing.items[0]!.caption).toContain('点头赞同');
    expect(listing.items[0]!.keywords).toEqual(expect.arrayContaining(['庆祝', '开心', '赞同', '点头', 'happy', 'like']));
    expect(await readFile(await module.fileFor({}, listing.items[0]!.id))).toEqual(GIF);
    expect(await readFile(join(a, 'image.gif'))).toEqual(GIF); expect(await readFile(join(b, 'image.gif'))).toEqual(GIF);
    expect(await migrateLegacyMemeCollections(f.root, f.shared)).toEqual({ imported: 0, merged: 0, alreadyMigrated: 2 });
    const db = new DatabaseSync(join(f.shared, 'index.db'), { readOnly: true });
    try { expect(db.prepare('SELECT metadata_json FROM zeta_legacy_sources').all()).toHaveLength(2); } finally { db.close(); }
    await module.dispose();
  });

  it('does not resurrect a migrated image deleted by the administrator after restart', async () => {
    const f = await fixture(); await f.seed('a', GIF, '一次迁移', 'misc', '原图');
    const first = new MemeModule(f.host);
    const item = (await first.list({}, { query: '一次迁移' })).items[0]!;
    await first.delete({}, item.id); await first.dispose();
    const restored = new MemeModule(f.host);
    expect((await restored.list({}, { query: '一次迁移' })).items).toHaveLength(0); await restored.dispose();
  });

  it('keeps all existing images beyond the new global capacity and refuses only new unique imports', async () => {
    const f = await fixture();
    await f.seed('a', GIF, '第一张', 'misc', '第一张');
    await f.seed('b', Buffer.concat([GIF, Buffer.from('b')]), '第二张', 'misc', '第二张');
    const module = new MemeModule(f.host, { maxCollectionItems: 1 });
    expect((await module.list({}, { limit: 50 })).items.filter(item => !item.builtin)).toHaveLength(2);
    await expect(module.importImage({}, Buffer.concat([GIF, Buffer.from('c')]), 'c.gif', { caption: '第三张' })).rejects.toThrow('已满');
    // Export must contain every migrated image rather than applying the new-item cap.
    expect((await module.exportZip({})).length).toBeGreaterThan(GIF.length * 2); await module.dispose();
  });

  it('fails explicitly on a missing legacy image and resumes the remaining migration after repair', async () => {
    const f = await fixture(); const old = await f.seed('a', GIF, '待修复', 'misc', '修复');
    await rm(join(old, 'image.gif'));
    await expect(migrateLegacyMemeCollections(f.root, f.shared)).rejects.toThrow();
    expect((await stat(join(old, 'index.db'))).isFile()).toBe(true);
    await writeFile(join(old, 'image.gif'), GIF);
    expect((await migrateLegacyMemeCollections(f.root, f.shared)).imported).toBe(1);
  });

  it('rejects an indexed path outside the legacy collection without changing that source', async () => {
    const f = await fixture(); const old = await f.seed('a', GIF, '正常', 'misc', '');
    const db = openIndexWriter(old);
    try { db.prepare('UPDATE memes SET path=?').run('../outside.gif'); } finally { db.close(); }
    await expect(migrateLegacyMemeCollections(f.root, f.shared)).rejects.toThrow('路径');
    expect(await readFile(join(old, 'image.gif'))).toEqual(GIF);
  });
});
