// A disc on the server, read a piece at a time and kept on this device.
//
// ?disc=<same-origin URL> hands the discio worker a plain {url, name, size, ...} in
// place of a dropped File. WORKERFS reads a mounted file with contents.slice(a, b),
// synchronously, from the core's proxied syscalls, so a RangeDisc stands in for the
// File and serves every slice from three tiers:
//
//   L1  the last RANGE_CACHE_BLOCKS blocks in memory (4 MiB blocks, 256 MiB);
//   L2  the whole image in the origin-private file system, one file per disc, read
//       through a FileSystemSyncAccessHandle (the discio worker is a dedicated worker,
//       where sync handles exist) and, in Chromium, written by the fetch worker through
//       a second, shared one, with a bitmap of the blocks it holds kept beside it -- the
//       bitmap says what is there, never the file's size;
//   L3  HTTP Range requests, made by a fetch worker (remote-disc-fetch.js).
//
// A read checks L1, then L2, then waits on L3 -- for the bytes it needs, not their whole
// block -- and every block that arrives whole from L3 is written to L2 (L1 and L2 only
// ever hold whole blocks). Meanwhile the fetch worker pulls the image into L2 in order,
// at most two requests in flight, and parks that stream whenever the core is waiting on
// a miss. After the first minutes nothing waits, and a second launch reads nothing from
// the network. Nothing here runs on import; the page imports the cache listing too.

export const RANGE_BLOCK = 4 * 1024 * 1024;
export const RANGE_CACHE_BLOCKS = 64;
export const MAX_IN_FLIGHT = 2;
export const DISC_CACHE_DIR = "dolphin-discs";
export const DISC_META_VERSION = 1;
// The sequential stream is held to this rate while the game runs, so a fast LAN does
// not turn the discio worker into a disc writer (each 4 MiB block costs it one sync
// write). 32 MiB/s is ~270 Mbit/s; before the boot ("download fully") it is unlimited.
export const SEQUENTIAL_CAP_WHILE_RUNNING = 32 * 1024 * 1024;

// Two sync handles on one file (the fetch worker writing, the discio worker reading)
// need this mode, which Chromium has had since 121; elsewhere one worker owns the copy.
export const SHARED_SYNC_MODE = "readwrite-unsafe";

// The block kinds the fetcher hands back; ahead blocks also go to L1, as before.
export const KIND_SEQUENTIAL = 0;
export const KIND_AHEAD = 1;
export const KIND_DEMAND = 2;

const PERSIST_INTERVAL_MS = 5000;     // image flush + bitmap write, at most this often
const META_INTERVAL_MS = 15000;       // the listing's progress figure, at most this often
const SPACE_MARGIN = 64 * 1024 * 1024;

const encoder = new TextEncoder();

/**
 * ?prefetch=0 turns the sequential fetcher off, ?opfs=0 the copy on this device;
 * ?recordreads=1 keeps the order the core reads the disc's blocks in (readOrder below).
 */
export function readRemoteDiscFlags(search) {
  const params = new URLSearchParams(search);
  const value = (name) => (params.get(name) ?? "").toLowerCase();
  const off = (name) => ["0", "false", "off", "no"].includes(value(name));
  const on = (name) => ["1", "true", "on", "yes"].includes(value(name));
  return { prefetch: !off("prefetch"), opfs: !off("opfs"), recordReads: on("recordreads") };
}

// ── the read order: which blocks a title reads first ──
// The sequential fetcher pulls the image from its first block to its last, so in a
// first launch it can be fetching the end of the disc while the game wants the middle.
// A read order, recorded once per disc file with ?recordreads=1 (the blocks the core
// touched, each once, in the order it first touched them) and kept beside the disc as
// <disc file>.reads.json, puts those blocks first: the fetcher takes them in that order,
// then the rest from the start. It is block numbers and times only -- nothing of the
// game -- so it can live in a repository. Without one (a 404, the normal case) nothing
// changes; one made for another file (another size or block size) is ignored.
export const READ_ORDER_VERSION = 1;

/** Where a disc's read order is kept: beside it, its file name + ".reads.json". */
export function readOrderUrl(discUrl) {
  const url = new URL(discUrl, globalThis.location?.href ?? "http://localhost/");
  url.pathname += ".reads.json";
  url.search = "";
  url.hash = "";
  return url.href;
}

/**
 * The blocks of a read-order file that apply to this disc, in order, each once:
 * { blocks } -- or { blocks: null, reason } when the file is for another disc or isn't one.
 */
export function parseReadOrder(json, { size, blockSize = RANGE_BLOCK }) {
  if (!json || json.v !== READ_ORDER_VERSION || !Array.isArray(json.blocks)) return { blocks: null, reason: "not a read order this page knows" };
  if (Number(json.size) !== Number(size) || Number(json.block) !== Number(blockSize)) {
    return { blocks: null, reason: `made for another file (${json.size} bytes in ${json.block}-byte blocks, not ${size} in ${blockSize})` };
  }
  const count = blockCount(size, blockSize);
  const seen = new Uint8Array(count);
  const blocks = [];
  for (const b of json.blocks) {
    if (Number.isInteger(b) && b >= 0 && b < count && !seen[b]) {
      seen[b] = 1;
      blocks.push(b);
    }
  }
  return { blocks, reason: null };
}

/** Fetch and check a disc's read order: { blocks, reason }; blocks null when there is none (404) or it doesn't apply. */
export async function loadReadOrder(source, { fetchImpl = (...args) => fetch(...args), blockSize = RANGE_BLOCK } = {}) {
  let response;
  try {
    response = await fetchImpl(readOrderUrl(source.url), { credentials: "same-origin", cache: "no-store" });
  } catch (error) {
    return { blocks: null, reason: `not fetched (${error?.message || error})` };
  }
  if (response.status === 404) return { blocks: null, reason: null };
  if (!response.ok) return { blocks: null, reason: `HTTP ${response.status}` };
  try {
    return parseReadOrder(await response.json(), { size: source.size, blockSize });
  } catch (error) {
    return { blocks: null, reason: `not JSON (${error?.message || error})` };
  }
}

export function blockCount(size, blockSize = RANGE_BLOCK) {
  return Math.ceil(size / blockSize);
}

export function blockLength(index, size, blockSize = RANGE_BLOCK) {
  return Math.max(0, Math.min(blockSize, size - index * blockSize));
}

// What identifies the bytes behind a URL: the size always, the ETag and Last-Modified
// whenever either side has them (a server that stops sending one counts as a change).
// The weak and strong forms of one ETag compare equal.
export function sameValidators(a, b) {
  if (Number(a?.size) !== Number(b?.size)) return false;
  const etag = (value) => (value ? String(value).replace(/^W\//, "") : "");
  if ((a.etag || b.etag) && etag(a.etag) !== etag(b.etag)) return false;
  if ((a.lastModified || b.lastModified) && String(a.lastModified ?? "") !== String(b.lastModified ?? "")) return false;
  return true;
}

// The file name for a disc's copy: a 64-bit hash of its URL. The metadata keeps the
// URL itself, so a collision reads as a different disc and is replaced, never mixed.
export function discCacheKey(url) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `disc-${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0).toString(16).padStart(8, "0")}`;
}

function cacheFileNames(key) {
  return { img: `${key}.img`, map: `${key}.map`, meta: `${key}.json` };
}

export function formatDiscBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

// Which blocks of the image are on this device, one bit each. The bytes may be a view
// of shared memory, which is how both workers see the same bits; only the worker that
// writes the copy sets them, and only after the block's bytes are written.
export class BlockBitmap {
  constructor(count, bytes = new Uint8Array(Math.ceil(count / 8))) {
    if (bytes.length !== Math.ceil(count / 8)) {
      throw new RangeError(`a bitmap of ${count} blocks needs ${Math.ceil(count / 8)} bytes, not ${bytes.length}`);
    }
    this.count = count;
    this.bytes = bytes;
    this.present = 0;
    this.recount();
  }

  has(index) {
    return index >= 0 && index < this.count && (Atomics.load(this.bytes, index >> 3) & (1 << (index & 7))) !== 0;
  }

  set(index) {
    if (!(index >= 0 && index < this.count)) throw new RangeError(`block ${index} is outside the disc`);
    const bit = 1 << (index & 7);
    if (Atomics.or(this.bytes, index >> 3, bit) & bit) return false;
    this.present++;
    return true;
  }

  clear() {
    this.bytes.fill(0);
    this.present = 0;
  }

  // Take persisted bits. Bits past the last block are noise and are dropped.
  load(bytes) {
    if (bytes.length !== this.bytes.length) throw new RangeError("bitmap length does not match the disc");
    this.bytes.set(bytes);
    this.recount();
  }

  // Safe beside a writer in another thread: the bytes are read atomically, and the tail
  // is only masked (atomically) when it holds stray bits.
  recount() {
    const tail = this.count & 7;
    const last = this.bytes.length - 1;
    if (tail && last >= 0 && (Atomics.load(this.bytes, last) & ~((1 << tail) - 1) & 0xff)) {
      Atomics.and(this.bytes, last, (1 << tail) - 1);
    }
    let present = 0;
    for (let i = 0; i <= last; i++) {
      let v = Atomics.load(this.bytes, i);
      while (v) { present += v & 1; v >>= 1; }
    }
    this.present = present;
    return present;
  }

  get complete() {
    return this.present === this.count;
  }

  firstMissing(from = 0) {
    for (let i = Math.max(0, from); i < this.count; i++) if (!this.has(i)) return i;
    return -1;
  }
}

async function readJsonFile(dir, name) {
  try {
    const file = await (await dir.getFileHandle(name)).getFile();
    return JSON.parse(await file.text());
  } catch {
    return null;   // missing or unreadable: either way there is nothing to trust
  }
}

async function removeIfPresent(dir, name) {
  try {
    await dir.removeEntry(name);
  } catch (error) {
    if (error?.name !== "NotFoundError") throw error;
  }
}

function closeQuietly(handle) {
  try { handle?.close(); } catch { /* already closed */ }
}

function storedBytesOf(bitmap, size, blockSize) {
  const last = bitmap.count - 1;
  if (last < 0) return 0;
  const full = bitmap.present * blockSize;
  return bitmap.has(last) ? full - (blockSize - blockLength(last, size, blockSize)) : full;
}

function metaMatches(meta, source, blockSize) {
  return Boolean(meta) && meta.v === DISC_META_VERSION && meta.url === source.url &&
    meta.blockSize === blockSize && sameValidators(meta, source);
}

function invalidationNote(meta, source, blockSize) {
  if (meta.v !== DISC_META_VERSION || meta.blockSize !== blockSize) return "the cache format changed";
  if (meta.url !== source.url) return "the copy belonged to another disc";
  if (Number(meta.size) !== Number(source.size)) return "the disc on the server changed size";
  return "the disc on the server changed";
}

// L2: the disc image in the origin-private file system. `<key>.img` holds the image at
// its own offsets, `<key>.map` the bitmap, `<key>.json` what the copy is of (url, size,
// ETag, Last-Modified) plus a progress figure for the listing. The image and bitmap stay
// open through sync handles for the session. Opened `shared`, the image handle lets the
// discio worker hold a reader beside it (OpfsDiscReader); a Web Lock taken by the opener
// (remote-disc-fetch.js) then keeps a second tab off the copy, which an exclusive handle
// does by itself.
export class OpfsDiscStore {
  // -> { store, reason, note }: a store, or null and why the disc streams instead.
  static async open({
    root,
    source,
    key = discCacheKey(source.url),
    blockSize = RANGE_BLOCK,
    bitmap = null,
    estimate = null,
    shared = false,
    now = () => Date.now()
  }) {
    const count = blockCount(source.size, blockSize);
    bitmap ??= new BlockBitmap(count);
    const names = cacheFileNames(key);
    const dir = await root.getDirectoryHandle(DISC_CACHE_DIR, { create: true });
    const meta = await readJsonFile(dir, names.meta);
    let note = meta && !metaMatches(meta, source, blockSize) ? invalidationNote(meta, source, blockSize) : null;
    let fresh = !metaMatches(meta, source, blockSize);

    let img = null;
    let map = null;
    try {
      const imgFile = await dir.getFileHandle(names.img, { create: true });
      if (typeof imgFile.createSyncAccessHandle !== "function") {
        return { store: null, reason: "this context has no synchronous file access", note };
      }
      img = await imgFile.createSyncAccessHandle(shared ? { mode: SHARED_SYNC_MODE } : undefined);
      map = await (await dir.getFileHandle(names.map, { create: true })).createSyncAccessHandle();
    } catch (error) {
      closeQuietly(img);
      const inUse = error?.name === "NoModificationAllowedError" || error?.name === "InvalidStateError";
      return { store: null, reason: inUse ? "the copy on this device is open in another tab" : `no access to this device's storage (${error?.name || error})`, note };
    }

    try {
      if (!fresh) {
        const bits = new Uint8Array(bitmap.bytes.length);
        if (img.getSize() !== source.size || map.getSize() !== bits.length || map.read(bits, { at: 0 }) !== bits.length) {
          fresh = true;
          note = "the copy on this device was incomplete or evicted; starting over";
        } else {
          bitmap.load(bits);
        }
      }
      if (fresh) {
        const previous = img.getSize();
        if (estimate) {
          const { usage = 0, quota = Infinity } = (await estimate()) ?? {};
          const free = quota - usage + previous;
          if (source.size > free - SPACE_MARGIN) {
            closeQuietly(img);
            closeQuietly(map);
            await Promise.all([removeIfPresent(dir, names.img), removeIfPresent(dir, names.map), removeIfPresent(dir, names.meta)]).catch(() => {});
            return {
              store: null,
              reason: `not enough space on this device (the disc is ${formatDiscBytes(source.size)}, ${formatDiscBytes(Math.max(0, free))} free)`,
              note
            };
          }
        }
        // The order makes a crash at any point safe: the bits go to zero before the
        // image is touched, and the metadata naming the new source is written last.
        bitmap.clear();
        map.truncate(0);
        if (map.write(new Uint8Array(bitmap.bytes.length), { at: 0 }) !== bitmap.bytes.length) throw new Error("the bitmap could not be written");
        map.flush();
        img.truncate(0);
        img.truncate(source.size);
        if (img.getSize() !== source.size) throw new Error("the image could not be sized");
        img.flush();
      }
    } catch (error) {
      closeQuietly(img);
      closeQuietly(map);
      const quota = error?.name === "QuotaExceededError" || /could not be sized/.test(error?.message ?? "");
      return {
        store: null,
        reason: quota ? `not enough space on this device for ${formatDiscBytes(source.size)}` : `the copy on this device could not be opened (${error?.message || error})`,
        note
      };
    }

    const store = new OpfsDiscStore({ dir, key, names, img, map, source, blockSize, bitmap, now, created: fresh ? now() : meta.created });
    store.shared = img.mode === SHARED_SYNC_MODE;
    try {
      await store.writeMeta();
    } catch (error) {
      store.close();
      return { store: null, reason: `the copy on this device could not be described (${error?.message || error})`, note };
    }
    return { store, reason: null, note: note ?? (fresh ? null : `resuming: ${formatDiscBytes(store.storedBytes)} already on this device`) };
  }

  constructor({ dir, key, names, img, map, source, blockSize, bitmap, now, created }) {
    this.dir = dir;
    this.key = key;
    this.names = names;
    this.img = img;
    this.map = map;
    this.source = { url: source.url, name: source.name, size: source.size, etag: source.etag ?? null, lastModified: source.lastModified ?? null };
    this.blockSize = blockSize;
    this.bitmap = bitmap;
    this.now = now;
    this.created = created ?? now();
    this.dirty = false;
    this.closed = false;
    this.metaChain = Promise.resolve();
  }

  has(index) {
    return !this.closed && this.bitmap.has(index);
  }

  read(view, position) {
    return this.img.read(view, { at: position });
  }

  // The bit is set in memory at once (this handle reads its own writes); it reaches the
  // bitmap file at the next persist, after the image has been flushed.
  write(index, bytes) {
    if (bytes.length !== blockLength(index, this.source.size, this.blockSize)) {
      throw new RangeError(`block ${index} is ${bytes.length} bytes`);
    }
    const written = this.img.write(bytes, { at: index * this.blockSize });
    if (written !== bytes.length) throw new Error(`short write (${written} of ${bytes.length})`);
    this.bitmap.set(index);
    this.dirty = true;
  }

  persist() {
    if (!this.dirty || this.closed) return false;
    this.img.flush();
    const bits = this.bitmap.bytes.slice();
    if (this.map.write(bits, { at: 0 }) !== bits.length) throw new Error("the bitmap could not be written");
    this.map.flush();
    this.dirty = false;
    return true;
  }

  get storedBytes() {
    return storedBytesOf(this.bitmap, this.source.size, this.blockSize);
  }

  get complete() {
    return this.bitmap.complete;
  }

  // The metadata goes through a sync handle of its own, opened for the write and closed
  // after it; writes are chained so two never hold it at once.
  writeMeta() {
    const meta = {
      v: DISC_META_VERSION,
      ...this.source,
      blockSize: this.blockSize,
      created: this.created,
      lastUsed: this.now(),
      storedBytes: this.storedBytes,
      complete: this.complete
    };
    const run = async () => {
      const handle = await (await this.dir.getFileHandle(this.names.meta, { create: true })).createSyncAccessHandle();
      try {
        const bytes = encoder.encode(JSON.stringify(meta));
        handle.truncate(0);
        if (handle.write(bytes, { at: 0 }) !== bytes.length) throw new Error("short metadata write");
        handle.flush();
      } finally {
        handle.close();
      }
    };
    const next = this.metaChain.then(run, run);
    this.metaChain = next.catch(() => {});
    return next;
  }

  // Synchronous up to the handles' release, so a caller that drops the store can reuse
  // the shared bitmap right after; the metadata update follows on its own.
  close() {
    if (this.closed) return this.metaChain;
    let persisted = null;
    try {
      this.persist();
    } catch (error) {
      persisted = error;
    }
    this.closed = true;
    closeQuietly(this.img);
    closeQuietly(this.map);
    const meta = persisted ? Promise.reject(persisted) : this.writeMeta();
    return meta;
  }

  async remove() {
    if (!this.closed) {
      this.closed = true;
      closeQuietly(this.img);
      closeQuietly(this.map);
    }
    await this.metaChain;
    await removeCachedDisc(this.dir, this.key, { inCacheDir: true });
  }
}

// The discio worker's side of a copy the fetch worker writes: a second, shared handle on
// the image, read only, and the shared bitmap the writer sets bits in. Nothing here
// writes, flushes or blocks on the disc beyond the reads themselves.
export class OpfsDiscReader {
  static async open({ root, source, key = discCacheKey(source.url), blockSize = RANGE_BLOCK, bitmap }) {
    const dir = await root.getDirectoryHandle(DISC_CACHE_DIR);
    const handle = await (await dir.getFileHandle(`${key}.img`)).createSyncAccessHandle({ mode: SHARED_SYNC_MODE });
    if (handle.mode !== SHARED_SYNC_MODE) {
      closeQuietly(handle);
      throw new Error("this browser has no shared sync access handles");
    }
    return new OpfsDiscReader({ handle, source, blockSize, bitmap });
  }

  constructor({ handle, source, blockSize, bitmap }) {
    this.remote = true;
    this.handle = handle;
    this.source = source;
    this.blockSize = blockSize;
    this.bitmap = bitmap;
    this.closed = false;
  }

  has(index) {
    return !this.closed && this.bitmap.has(index);
  }

  read(view, position) {
    return this.handle.read(view, { at: position });
  }

  get storedBytes() {
    this.bitmap.recount();
    return storedBytesOf(this.bitmap, this.source.size, this.blockSize);
  }

  get complete() {
    return this.bitmap.recount() === this.bitmap.count;
  }

  close() {
    this.closed = true;
    closeQuietly(this.handle);
    return Promise.resolve();
  }
}

async function cacheDir(root, create = false) {
  try {
    return await root.getDirectoryHandle(DISC_CACHE_DIR, { create });
  } catch (error) {
    if (error?.name === "NotFoundError" || error?.name === "TypeError") return null;
    throw error;
  }
}

/**
 * The discs kept on this device, most recently used first:
 * [{ key, name, url, size, storedBytes, complete, lastUsed }]. A copy whose metadata is
 * missing (a crash before it was written) is listed with storedBytes null, so it can
 * still be removed.
 */
export async function listCachedDiscs(root) {
  const dir = root ? await cacheDir(root) : null;
  if (!dir) return [];
  const keys = new Set();
  for await (const name of dir.keys()) {
    const match = /^(.*)\.(img|map|json)$/.exec(name);
    if (match) keys.add(match[1]);
  }
  const discs = [];
  for (const key of keys) {
    const names = cacheFileNames(key);
    const meta = await readJsonFile(dir, names.meta);
    if (meta?.v === DISC_META_VERSION) {
      discs.push({
        key,
        name: String(meta.name || meta.url || key),
        url: meta.url ?? null,
        size: Number(meta.size) || 0,
        storedBytes: Number(meta.storedBytes) || 0,
        complete: Boolean(meta.complete),
        lastUsed: Number(meta.lastUsed) || 0
      });
    } else {
      let size = 0;
      try { size = (await (await dir.getFileHandle(names.img)).getFile()).size; } catch { /* no image either */ }
      discs.push({ key, name: "(incomplete copy)", url: null, size, storedBytes: null, complete: false, lastUsed: 0 });
    }
  }
  return discs.sort((a, b) => b.lastUsed - a.lastUsed);
}

/** Remove one disc's copy. Throws NoModificationAllowedError while a worker holds it. */
export async function removeCachedDisc(root, key, { inCacheDir = false } = {}) {
  const dir = inCacheDir ? root : await cacheDir(root);
  if (!dir) return false;
  const names = cacheFileNames(key);
  await removeIfPresent(dir, names.img);
  await removeIfPresent(dir, names.map);
  await removeIfPresent(dir, names.meta);
  return true;
}

/** The listing entry for this exact source (same URL and validators), or null. */
export async function readCachedDiscEntry(root, source, blockSize = RANGE_BLOCK) {
  const dir = root ? await cacheDir(root) : null;
  if (!dir) return null;
  const key = discCacheKey(source.url);
  const meta = await readJsonFile(dir, cacheFileNames(key).meta);
  if (!meta) return null;
  return {
    key,
    matches: metaMatches(meta, source, blockSize),
    storedBytes: Number(meta.storedBytes) || 0,
    complete: Boolean(meta.complete),
    size: Number(meta.size) || 0
  };
}

/**
 * Bytes [start, end) from this device's copy when every block they touch is there
 * and the copy is of this exact source; null otherwise. For the page, which reads the
 * disc header before any worker exists (and so before anything holds the files).
 */
export async function readCachedRange(root, source, start, end, blockSize = RANGE_BLOCK) {
  const dir = root ? await cacheDir(root) : null;
  if (!dir || !(end > start)) return null;
  const names = cacheFileNames(discCacheKey(source.url));
  const meta = await readJsonFile(dir, names.meta);
  if (!metaMatches(meta, source, blockSize)) return null;
  try {
    const bitmap = new BlockBitmap(blockCount(source.size, blockSize));
    const bits = new Uint8Array(await (await (await dir.getFileHandle(names.map)).getFile()).arrayBuffer());
    bitmap.load(bits);
    for (let i = Math.floor(start / blockSize); i <= Math.floor((end - 1) / blockSize); i++) {
      if (!bitmap.has(i)) return null;
    }
    const file = await (await dir.getFileHandle(names.img)).getFile();
    if (file.size !== source.size) return null;
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  } catch {
    return null;
  }
}

// The disc WORKERFS reads. The object the main thread posts is the plain {url, name,
// size, etag, lastModified, prefetch, opfs} (methods don't survive structured clone);
// openRangeDisc() builds this around it. `fetcher` is a FetchWorkerClient or an
// InlineFetcher (remote-disc-fetch.js). `store` is an OpfsDiscReader when the fetch
// worker writes the copy (then nothing here writes), an OpfsDiscStore when this worker
// owns it, or null.
export class RangeDisc {
  constructor(source, {
    fetcher,
    store = null,
    storeReason = null,
    prefetch = true,
    recordReads = false,
    readError = (error) => error,
    log = () => {},
    now = () => performance.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id)
  }) {
    this.url = source.url;
    this.name = source.name;
    this.size = source.size;
    this.type = "application/octet-stream";
    this.blockSize = RANGE_BLOCK;
    this.blockCount = blockCount(source.size, this.blockSize);
    this.blocks = new Map();                 // L1, freshest last
    this.fetcher = fetcher;
    this.store = store;
    this.storeReason = store ? null : storeReason;
    this.prefetch = Boolean(prefetch);
    this.readError = readError;
    this.log = log;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.gameRunning = false;
    this.waits = 0;
    this.waitMs = 0;
    this.lastWaitMs = 0;
    this.progressWaits = 0;                  // waits on a block a read before was already waiting on
    this.progressMs = 0;
    this.fillingHits = 0;                    // reads answered from a block still arriving, without waiting
    this.l1Hits = 0;
    this.l2Hits = 0;
    this.readyHits = 0;
    this.busy = { writeMs: 0, writeMaxMs: 0, persistMs: 0, persistMaxMs: 0, drainMs: 0, drainMaxMs: 0 };
    this.lastAhead = -1;
    this.sequentialSent = null;
    this.persistTimer = null;
    this.lastMetaAt = this.now();
    this.rateSamples = [];
    this.closed = false;
    this.changed = false;
    this.completeSeen = Boolean(store?.remote && store.complete);
    // ?recordreads=1: each block the core reads, the first time it reads it, and when
    this.recording = recordReads ? { since: this.now(), seen: new Uint8Array(this.blockCount), blocks: [], seconds: [] } : null;
    this.order = null;                       // { blocks, from } once a read order is in use
    fetcher.onReady = () => this.consumeReady();
    this.updateSequential();
  }

  record(index) {
    const rec = this.recording;
    if (!rec || rec.seen[index]) return;
    rec.seen[index] = 1;
    rec.blocks.push(index);
    rec.seconds.push(Math.round((this.now() - rec.since) / 100) / 10);
  }

  /** The read order recorded so far (?recordreads=1), in the form readOrderUrl() serves; null when not recording. */
  readOrder() {
    const rec = this.recording;
    if (!rec) return null;
    return { v: READ_ORDER_VERSION, name: this.name, size: this.size, block: this.blockSize, blocks: rec.blocks.slice(), seconds: rec.seconds.slice() };
  }

  /** Hand the fetcher a read order: the sequential stream takes these blocks first. */
  useReadOrder(blocks, from) {
    if (this.closed || !blocks?.length) return;
    this.order = { blocks: blocks.length, from };
    this.fetcher.setOrder?.(blocks);
    this.log(`read order from ${from}: ${blocks.length} blocks first`);
  }

  slice(start = 0, end = this.size) {
    start = Math.max(0, Math.min(start, this.size));
    end = Math.max(start, Math.min(end, this.size));
    this.consumeReady();
    const out = new Uint8Array(end - start);
    let pos = start;
    let off = 0;
    let last = -1;
    try {
      while (pos < end) {
        const i = Math.floor(pos / this.blockSize);
        const from = pos - i * this.blockSize;
        const n = Math.min(blockLength(i, this.size, this.blockSize) - from, end - pos);
        if (this.recording) this.record(i);
        this.readInto(i, from, out.subarray(off, off + n));
        pos += n;
        off += n;
        last = i;
      }
    } catch (error) {
      throw this.readError(error);
    }
    if (last >= 0) this.ahead(last + 1);
    return { size: out.length, buffer: out.buffer };
  }

  // L1, then L2, then L3. L3 is asked for the window this read needs (`from`, the view's
  // length) and answers as soon as it has arrived; a block that had arrived whole goes to
  // L1 (as the in-memory reader always did) and to L2. A block still arriving stays out
  // of both: L1 and L2 only ever hold whole blocks, so a read is never served from a
  // block's filled part here. A later read into it goes back to the fetcher, which
  // answers from the same slot (no second request); once whole, the block comes back
  // through consumeReady() into L1 and L2.
  readInto(index, from, view) {
    const cached = this.blocks.get(index);
    if (cached) {
      this.blocks.delete(index);
      this.blocks.set(index, cached);
      view.set(cached.subarray(from, from + view.length));
      this.l1Hits++;
      return;
    }
    if (this.store?.has(index)) {
      try {
        if (this.store.read(view, index * this.blockSize + from) === view.length) {
          this.l2Hits++;
          return;
        }
        this.dropStore("the copy on this device came back short");
      } catch (error) {
        this.dropStore(`reading the copy on this device failed (${error?.message || error})`);
      }
    }
    const t0 = this.now();
    const got = this.fetcher.demand(index, from, view.length);
    this.lastAhead = -1;
    if (got.waited) {
      const ms = this.now() - t0;
      this.waits++;
      this.waitMs += ms;
      this.lastWaitMs = ms;
      if (got.follow) {
        this.progressWaits++;
        this.progressMs += ms;
      }
    } else if (got.filling) {
      this.fillingHits++;
    } else {
      this.readyHits++;
    }
    const at = got.from ?? 0;
    if (at === 0 && got.bytes.length === blockLength(index, this.size, this.blockSize)) {
      this.keep(index, got.bytes);
      this.storeBlock(index, got.bytes);
    }
    view.set(got.bytes.subarray(from - at, from - at + view.length));
  }

  // One block ahead of every read, as the in-memory reader did: a file read straight
  // through misses once, then finds each next block already on its way.
  ahead(index) {
    if (index >= this.blockCount || index === this.lastAhead) return;
    if (this.blocks.has(index) || this.store?.has(index)) return;
    this.lastAhead = index;
    this.fetcher.ahead(index);
  }

  keep(index, bytes) {
    this.blocks.delete(index);
    this.blocks.set(index, bytes);
    while (this.blocks.size > RANGE_CACHE_BLOCKS) this.blocks.delete(this.blocks.keys().next().value);
  }

  // Time the discio worker spends on the copy here, by kind, for the stats: this is
  // what the background download costs the thread the core's reads run on.
  spent(kind, t0) {
    const ms = this.now() - t0;
    this.busy[`${kind}Ms`] += ms;
    if (ms > this.busy[`${kind}MaxMs`]) this.busy[`${kind}MaxMs`] = ms;
  }

  storeBlock(index, bytes) {
    if (!this.store || this.store.remote || this.changed || this.store.has(index)) return;
    const t0 = this.now();
    try {
      this.store.write(index, bytes);
    } catch (error) {
      this.dropStore(`writing to this device failed (${error?.message || error})`);
      return;
    } finally {
      this.spent("write", t0);
    }
    if (this.store.complete) this.completed();
    else this.schedulePersist();
  }

  // Blocks the fetch worker finished in the background. Sequential ones go to L2 only
  // (the whole disc passing through L1 would flush it), ahead ones to both.
  consumeReady() {
    if (this.closed) return;
    if (this.fetcher.changed && !this.changed) {
      this.changed = true;
      this.blocks.clear();
      this.dropStore("the disc changed on the server; reload to fetch it again", { remove: true });
    }
    if (this.store?.remote) {
      const lost = this.fetcher.storeLost;
      if (lost) this.dropStore(lost, { remote: false });
      else if (!this.completeSeen && this.fetcher.storeComplete) this.completed();
    }
    const t0 = this.now();
    let any = false;
    this.fetcher.drainReady((index, kind, bytes) => {
      any = true;
      if (kind === KIND_AHEAD || !this.store) this.keep(index, bytes.slice());
      this.storeBlock(index, bytes);
    });
    if (any) this.spent("drain", t0);
  }

  updateSequential() {
    const done = this.store?.remote ? this.completeSeen : this.store?.complete;
    const on = Boolean(this.prefetch && this.store && !done && !this.closed && !this.changed);
    const cap = this.gameRunning ? SEQUENTIAL_CAP_WHILE_RUNNING : 0;
    const key = `${on}:${cap}`;
    if (key === this.sequentialSent) return;
    this.sequentialSent = key;
    this.fetcher.setSequential(on, cap);
  }

  setGameRunning(running) {
    this.gameRunning = Boolean(running);
    this.updateSequential();
  }

  schedulePersist() {
    if (this.persistTimer != null) return;
    this.persistTimer = this.setTimer(() => {
      this.persistTimer = null;
      this.persistNow();
    }, PERSIST_INTERVAL_MS);
  }

  persistNow({ meta = false } = {}) {
    const store = this.store;
    if (!store) return;
    if (store.remote) {
      this.fetcher.flushStore?.();
      return;
    }
    const t0 = this.now();
    try {
      store.persist();
    } catch (error) {
      this.dropStore(`saving progress on this device failed (${error?.message || error})`);
      return;
    } finally {
      this.spent("persist", t0);
    }
    if (meta || this.now() - this.lastMetaAt >= META_INTERVAL_MS) {
      this.lastMetaAt = this.now();
      store.writeMeta().catch((error) => this.log(`metadata write failed: ${error?.message || error}`));
    }
  }

  completed() {
    this.completeSeen = true;
    if (this.persistTimer != null) {
      this.clearTimer(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistNow({ meta: true });
    this.updateSequential();
    this.log(`the whole disc is on this device (${formatDiscBytes(this.size)})`);
  }

  // Back to L1 + L3. A copy this worker owns is closed (or removed) and the shared bitmap
  // cleared once written out, so the fetch worker stops skipping blocks that are no
  // longer anywhere. A copy the fetch worker writes: the reader goes first (an open
  // handle would block the removal), then the fetch worker drops it, unless it is the
  // one that lost it (`remote: false`).
  dropStore(reason, { remove = false, remote = true } = {}) {
    const store = this.store;
    if (!store) return Promise.resolve();
    this.store = null;
    this.storeReason = reason;
    if (this.persistTimer != null) {
      this.clearTimer(this.persistTimer);
      this.persistTimer = null;
    }
    this.log(`streaming from the network: ${reason}`);
    let done;
    if (store.remote) {
      store.close();
      done = remote ? this.fetcher.dropStore({ remove }) : Promise.resolve();
    } else {
      done = remove ? store.remove() : store.close();
      store.bitmap.clear();
    }
    this.updateSequential();
    return done.catch((error) => this.log(`closing the copy on this device: ${error?.message || error}`));
  }

  removeFromDevice() {
    return this.dropStore("removed from this device", { remove: true });
  }

  get stats() {
    const counters = this.fetcher.counters();
    const now = this.now();
    this.rateSamples.push([now, counters.bytes]);
    while (this.rateSamples.length > 2 && now - this.rateSamples[0][0] > 5000) this.rateSamples.shift();
    const [t0, b0] = this.rateSamples[0];
    const rate = now - t0 > 0 ? (counters.bytes - b0) / ((now - t0) / 1000) : 0;
    return {
      url: this.url,
      name: this.name,
      size: this.size,
      blockSize: this.blockSize,
      blocks: this.blockCount,
      requests: counters.requests,
      bytes: counters.bytes,
      waits: this.waits,
      waitMs: Math.round(this.waitMs),
      l1Hits: this.l1Hits,
      l2Hits: this.l2Hits,
      readyHits: this.readyHits,
      fillingHits: this.fillingHits,
      // Per demand: reads that waited on the network and how long until the window they
      // needed had arrived (the same as waits/waitMs), how many of them waited on a block
      // already arriving for a read before them; blocks a read waited on, once whole, and
      // the time from the first read's demand to the whole block; requests that began at
      // a window ahead of the block's start, and that restarted at a later read's window.
      demand: {
        waits: this.waits,
        windowMs: Math.round(this.waitMs),
        lastWindowMs: Math.round(this.lastWaitMs),
        progressWaits: this.progressWaits,
        progressMs: Math.round(this.progressMs),
        blocks: counters.blocks ?? 0,
        blockMs: Math.round(counters.blockMs ?? 0),
        lastBlockMs: Math.round(counters.lastBlockMs ?? 0),
        windowFirst: counters.windowFirst ?? 0,
        restarts: counters.restarts ?? 0
      },
      link: this.linkStats(),
      salvagedBytes: counters.salvaged,
      aborts: counters.aborts,
      mode: this.store ? "cached" : "streaming",
      reason: this.store ? null : this.storeReason,
      storedBytes: this.store?.storedBytes ?? 0,
      storedBlocks: this.store ? (this.store.remote ? this.store.bitmap.recount() : this.store.bitmap.present) : 0,
      complete: Boolean(this.store?.complete),
      sequential: this.store?.complete ? "done" : this.fetcher.sequentialState(),
      rate: Math.round(rate),
      transport: this.fetcher.kind,
      writer: this.store ? (this.store.remote ? "fetch worker" : "discio worker") : null,
      busy: Object.fromEntries(Object.entries(this.busy).map(([k, v]) => [k, Math.round(v)])),
      readOrder: this.order,
      recorded: this.recording ? this.recording.blocks.length : null,
      fetchWorkerBusy: this.fetcher.busy?.() ?? null
    };
  }

  // The fetcher's estimate of the link, for tuning: throughput while a response is
  // arriving and time to its first bytes (which includes the server's own); null until
  // it has one.
  linkStats() {
    const link = this.fetcher.link?.();
    if (!link || !(link.bytesPerSecond > 0 || link.rttMs > 0)) return null;
    return {
      mbit: Math.round((link.bytesPerSecond * 8) / 1e5) / 10,
      rttMs: Math.round(link.rttMs),
      rttMinMs: Math.round(link.rttMinMs)
    };
  }

  flush() {
    this.persistNow({ meta: true });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.persistTimer != null) this.clearTimer(this.persistTimer);
    this.persistTimer = null;
    const store = this.store;
    this.store = null;
    if (store?.remote) store.close();
    await this.fetcher.close();
    if (store && !store.remote) await store.close().catch(() => {});
  }
}

/**
 * Build the RangeDisc for a posted source: the fetcher first (it owns the shared bitmap
 * and, where shared sync handles exist, opens and writes this device's copy), then a
 * reader on that copy -- or, without a writing fetch worker, the copy itself -- unless
 * ?opfs=0 or there is no room.
 */
export async function openRangeDisc(source, {
  opfs = true,
  prefetch = true,
  loadOrder = null,                          // e.g. loadReadOrder: where this disc's read order comes from
  getRoot = null,
  estimate = null,
  createFetcher,
  log = () => {},
  ...options
}) {
  const fetcher = await createFetcher(source, { opfs });
  const count = blockCount(source.size);
  const bitmap = new BlockBitmap(count, fetcher.bitmapBytes ?? undefined);
  const report = fetcher.storeReport ?? null;
  let store = null;
  let storeReason = "turned off (?opfs=0)";
  if (opfs) {
    if (report?.note) log(report.note);
    if (!getRoot) {
      storeReason = "this browser has no origin-private file system";
    } else if (report?.writer && !report.ok) {
      storeReason = report.reason;
    } else if (report?.writer) {
      try {
        store = await OpfsDiscReader.open({ root: await getRoot(), source, bitmap });
        storeReason = null;
      } catch (error) {
        storeReason = `this device's copy could not be read here (${error?.message || error})`;
        await fetcher.dropStore?.({ remove: false });
      }
    } else {
      try {
        const opened = await OpfsDiscStore.open({ root: await getRoot(), source, bitmap, estimate });
        store = opened.store;
        storeReason = opened.reason;
        if (opened.note) log(opened.note);
      } catch (error) {
        storeReason = `this device's storage is unavailable (${error?.message || error})`;
      }
    }
  }
  if (!store) log(`streaming from the network: ${storeReason}`);
  const disc = new RangeDisc(source, { fetcher, store, storeReason, prefetch, recordReads: Boolean(source.recordReads), log, ...options });
  // The read order, if the disc has one beside it: not waited for (a 404 is the normal case).
  // Only the sequential stream uses it, and there is none without this device's copy.
  if (loadOrder && !(prefetch && store)) {
    log(`no read order: no sequential stream (${!prefetch ? "?prefetch=0" : storeReason})`);
  } else if (loadOrder) {
    loadOrder(source).then(({ blocks, reason }) => {
      if (blocks) disc.useReadOrder(blocks, readOrderUrl(source.url).split("/").pop());
      else if (reason) log(`read order not used: ${reason}`);
    }, () => {});
  }
  return disc;
}
