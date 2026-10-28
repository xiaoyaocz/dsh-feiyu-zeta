# dsh-meme source integration

Upstream: https://github.com/yyh-001/dsh-meme

Version: 0.1.65. Commit: 49e2a7e5a56f271b91e8f5ee71ccce9d0c9d1a2c.

`memes.js`, its read-only SQLite index and the 24-image `dafeiyu-001` pack are
copied from upstream under the included MIT license. dsh-feiyu-zeta reuses the
upstream `MemesStore`, `searchRows` Chinese keyword/bigram search and pack writer.
It does not mount upstream's host plugin, HTTP routes, separate IM channel or
global collector. `src/zeta/memes.ts` supplies one shared user collection across
QQ conversations and autonomous activity, migrates older scoped collections,
and awaits the shared QQ sender. User collections live outside this package.

The current integrated surface is list/search, send, local-image collection,
metadata editing, managed upload/delete, image preview and bounded ZIP import /
export compatible with upstream's `index.db` + indexed images format. `zip.js`
adapts upstream's ZIP STORE writer and adds a strict STORE/DEFLATE reader.
Collection metadata
is supplied by the current model or administrator. Automatic visual captioning,
the upstream pack marketplace are not mounted by this
adapter. GIF bytes are preserved when an original GIF file is supplied; a frame
already flattened by an attachment provider cannot be reconstructed.
