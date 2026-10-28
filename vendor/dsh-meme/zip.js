/**
 * ZIP STORE writer adapted from yyh-001/dsh-meme/index.js (MIT).
 * Reader adds entry, byte, path, CRC and inflation bounds for scoped imports.
 */
import { inflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ c >>> 1 : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ c >>> 8;
  return (c ^ -1) >>> 0;
}

export function zipStore(files) {
  const parts = [], central = [];
  let offset = 0;
  if (files.length > 65534) throw new Error('ZIP entries exceed supported bounds');
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(f.data.length, 18); lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    parts.push(lh, nameBuf, f.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(f.data.length, 20); ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + f.data.length;
  }
  const cdSize = central.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, eocd]);
}

export function safeArchiveName(input) {
  if (!input || input.length > 1024 || /[\\:\0]/u.test(input) || input.startsWith('/')) throw new Error('ZIP 条目路径无效或越界');
  const name = input.endsWith('/') ? input.slice(0, -1) : input;
  if (name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('ZIP 条目路径无效或越界');
  return input;
}

export function unzipBounded(input, limits = {}) {
  const maxEntries = limits.maxEntries ?? 600;
  const maxEntryBytes = limits.maxEntryBytes ?? 12 * 1024 * 1024;
  const maxTotalBytes = limits.maxTotalBytes ?? 64 * 1024 * 1024;
  const maxArchiveBytes = limits.maxArchiveBytes ?? 80 * 1024 * 1024;
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buf.length < 22 || buf.length > maxArchiveBytes) throw new Error('ZIP 大小无效或超限');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50 && i + 22 + buf.readUInt16LE(i + 20) === buf.length) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
  const count = buf.readUInt16LE(eocd + 10), start = buf.readUInt32LE(eocd + 16), size = buf.readUInt32LE(eocd + 12);
  if (buf.readUInt16LE(eocd + 4) || buf.readUInt16LE(eocd + 6) || buf.readUInt16LE(eocd + 8) !== count) throw new Error('不支持多卷 ZIP');
  if (count > maxEntries || count === 65535 || start === 0xffffffff || size === 0xffffffff) throw new Error('ZIP 条数超限或使用了 ZIP64');
  if (start + size > eocd || start > eocd) throw new Error('ZIP 中央目录损坏');
  let pos = start, total = 0;
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (pos + 46 > start + size || buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const flags = buf.readUInt16LE(pos + 8), method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16), compSize = buf.readUInt32LE(pos + 20), rawSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28), extraLen = buf.readUInt16LE(pos + 30), commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42), attributes = buf.readUInt32LE(pos + 38);
    if (pos + 46 + nameLen + extraLen + commentLen > start + size || localOffset + 30 > start) throw new Error('ZIP 条目边界损坏');
    const name = safeArchiveName(buf.toString('utf8', pos + 46, pos + 46 + nameLen));
    if (flags & 1 || flags & 64) throw new Error('不支持加密 ZIP');
    if (((attributes >>> 16) & 0xf000) === 0xa000) throw new Error('ZIP 不允许符号链接');
    if (out.has(name)) throw new Error('ZIP 包含重复条目');
    if (method !== 0 && method !== 8) throw new Error('ZIP 使用了不支持的压缩方式');
    if (rawSize > maxEntryBytes || total + rawSize > maxTotalBytes) throw new Error('ZIP 解压大小超限');
    if (method === 0 && compSize !== rawSize) throw new Error('ZIP STORE 长度不一致');
    if (buf.readUInt32LE(localOffset) !== 0x04034b50 || buf.readUInt16LE(localOffset + 8) !== method) throw new Error('ZIP 本地文件头损坏');
    const localNameLen = buf.readUInt16LE(localOffset + 26), localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > start || dataStart > start || buf.toString('utf8', localOffset + 30, localOffset + 30 + localNameLen) !== name) throw new Error('ZIP 文件数据越界');
    const compressed = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: Math.min(maxEntryBytes, maxTotalBytes - total) });
    if (data.length !== rawSize || crc32(data) !== crc) throw new Error('ZIP 图片或索引校验失败');
    total += data.length;
    out.set(name, data);
    pos += 46 + nameLen + extraLen + commentLen;
  }
  if (pos !== start + size) throw new Error('ZIP 中央目录长度不一致');
  return out;
}
