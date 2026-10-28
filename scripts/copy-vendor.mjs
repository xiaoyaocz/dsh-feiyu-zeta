import { access, copyFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const vendor = join(root, 'vendor', 'dsh-meme');
await access(join(vendor, 'memes.js'));
await access(join(vendor, 'memes', 'dafeiyu-001', 'index.db'));
let count = 0;
async function countImages(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await countImages(path);
    else if (/\.(png|jpe?g|gif|webp)$/i.test(entry.name)) count++;
  }
}
await countImages(join(vendor, 'memes'));
if (count < 24) throw new Error(`Bundled dsh-meme images missing: ${count}/24`);
await mkdir(join(root, 'dist', 'licenses'), { recursive: true });
await copyFile(join(vendor, 'LICENSE'), join(root, 'dist', 'licenses', 'dsh-meme-MIT.txt'));
console.log(`dsh-meme resources verified: ${count} images; include vendor/** in the package.`);
