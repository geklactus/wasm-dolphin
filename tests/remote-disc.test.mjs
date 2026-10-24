import assert from "node:assert/strict";
import test from "node:test";

import {
  BlockBitmap,
  DISC_CACHE_DIR,
  KIND_AHEAD,
  KIND_SEQUENTIAL,
  OpfsDiscStore,
  RANGE_BLOCK,
  RANGE_CACHE_BLOCKS,
  RangeDisc,
  SEQUENTIAL_CAP_WHILE_RUNNING,
  blockCount,
  discCacheKey,
  listCachedDiscs,
  loadReadOrder,
  openRangeDisc,
  parseReadOrder,
  readCachedDiscEntry,
  readCachedRange,
  readOrderUrl,
  readRemoteDiscFlags,
  removeCachedDisc,
  sameValidators
} from "../src/remote-disc.js";
import { FakeDirectory } from "./helpers/fake-opfs.mjs";

const B = RANGE_BLOCK;
const discByte = (o) => (o ^ (o >>> 8) ^ (o >>> 16) ^ 0x5a) & 0xff;

function discBytes(start, end) {
  const out = new Uint8Array(end - start);
  for (let i = 0; i < out.length; i++) out[i] = discByte(start + i);
  return out;
}

function source(overrides = {}) {
  return {
    url: "http://127.0.0.1:8085/disc/game.rvz",
    name: "game.rvz",
    size: 2 * B + B / 2,           // three blocks, the last one short
    etag: "\"v1\"",
    lastModified: "Thu, 01 Oct 2026 00:00:00 GMT",
    ...overrides
  };
}

function blockOf(src, i) {
  return discBytes(i * B, Math.min(src.size, (i + 1) * B));
}

function fakeFetcher(src, { bitmapBytes = null } = {}) {
  return {
    kind: "fake",
    bitmapBytes,
    onReady: null,
    changed: false,
    demands: [],
    aheads: [],
    sequential: [],
    ready: [],
    closed: false,
    demand(i) {
      this.demands.push(i);
      return { bytes: blockOf(src, i), waited: true };
    },
    ahead(i) {
      this.aheads.push(i);
    },
    drainReady(take) {
      for (const [i, kind] of this.ready.splice(0)) take(i, kind, blockOf(src, i));
    },
    setSequential(on, cap) {
      this.sequential.push([on, cap]);
    },
    counters() {
      return { bytes: 0, requests: 0, salvaged: 0, aborts: 0 };
    },
    sequentialState() {
      return "running";
    },
    close() {
      this.closed = true;
    }
  };
}

function manualTimers() {
  const timers = new Map();
  let next = 1;
  return {
    setTimer: (fn) => { const id = next++; timers.set(id, fn); return id; },
    clearTimer: (id) => { timers.delete(id); },
    runAll() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
    get pending() { return timers.size; }
  };
}

const roomy = async () => ({ usage: 0, quota: 64 * B });

async function openStore(root, src = source(), extra = {}) {
  return OpfsDiscStore.open({ root, source: src, estimate: roomy, ...extra });
}

function cacheFiles(root, src = source()) {
  const dir = root.dir(DISC_CACHE_DIR);
  const key = discCacheKey(src.url);
  return { dir, img: dir?.file(`${key}.img`), map: dir?.file(`${key}.map`), meta: dir?.file(`${key}.json`) };
}

test("bitmap counts blocks, ignores bits past the end, finds the first missing block", () => {
  const bitmap = new BlockBitmap(10);
  assert.equal(bitmap.bytes.length, 2);
  assert.equal(bitmap.set(0), true);
  assert.equal(bitmap.set(0), false, "setting twice counts once");
  bitmap.set(9);
  assert.equal(bitmap.present, 2);
  assert.equal(bitmap.has(9), true);
  assert.equal(bitmap.has(10), false);
  assert.equal(bitmap.firstMissing(), 1);
  assert.throws(() => bitmap.set(10), RangeError);

  bitmap.load(Uint8Array.of(0xff, 0xff));          // bits 10..15 are noise
  assert.equal(bitmap.present, 10);
  assert.equal(bitmap.complete, true);
  assert.equal(bitmap.firstMissing(), -1);
  assert.equal(bitmap.bytes[1], 0x03);
  assert.throws(() => bitmap.load(new Uint8Array(3)), RangeError);

  const shared = new Uint8Array(new SharedArrayBuffer(2));
  const view = new BlockBitmap(10, shared);
  view.set(4);
  assert.equal(shared[0], 0x10, "a shared view is written in place");
  assert.throws(() => new BlockBitmap(10, new Uint8Array(1)), RangeError);
});

test("?prefetch=0 turns off the sequential stream, ?opfs=0 the copy on this device, ?recordreads=1 records", () => {
  assert.deepEqual(readRemoteDiscFlags(""), { prefetch: true, opfs: true, recordReads: false });
  assert.deepEqual(readRemoteDiscFlags("?disc=/d/x.rvz&prefetch=0"), { prefetch: false, opfs: true, recordReads: false });
  assert.deepEqual(readRemoteDiscFlags("?opfs=0"), { prefetch: true, opfs: false, recordReads: false });
  assert.deepEqual(readRemoteDiscFlags("?prefetch=off&opfs=false"), { prefetch: false, opfs: false, recordReads: false });
  assert.deepEqual(readRemoteDiscFlags("?prefetch=1&opfs=1&recordreads=1"), { prefetch: true, opfs: true, recordReads: true });
});

test("a read order: beside the disc, for that file only, each block once, junk dropped", async () => {
  assert.equal(readOrderUrl("http://h/disc/wii/Mario Kart.rvz?x=1"), "http://h/disc/wii/Mario%20Kart.rvz.reads.json");
  const src = source();
  const order = { v: 1, size: src.size, block: B, blocks: [2, 0, 2, 7, -1, "1", 1] };
  assert.deepEqual(parseReadOrder(order, { size: src.size }).blocks, [2, 0, 1]);
  assert.equal(parseReadOrder({ ...order, size: src.size + 1 }, { size: src.size }).blocks, null, "another file");
  assert.match(parseReadOrder({ ...order, block: B / 2 }, { size: src.size }).reason, /another file/);
  assert.equal(parseReadOrder({ ...order, v: 2 }, { size: src.size }).blocks, null);
  const reply = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  assert.deepEqual(await loadReadOrder(src, { fetchImpl: reply(404) }), { blocks: null, reason: null }, "a 404 is the normal case");
  assert.deepEqual((await loadReadOrder(src, { fetchImpl: reply(200, order) })).blocks, [2, 0, 1]);
  assert.match((await loadReadOrder(src, { fetchImpl: reply(500) })).reason, /HTTP 500/);
  assert.match((await loadReadOrder(src, { fetchImpl: async () => { throw new TypeError("offline"); } })).reason, /offline/);
});

test("validators: the size always, ETag and Last-Modified whenever either side has one", () => {
  const a = { size: 10, etag: "\"x\"", lastModified: "L" };
  assert.equal(sameValidators(a, { ...a }), true);
  assert.equal(sameValidators(a, { ...a, size: 11 }), false);
  assert.equal(sameValidators(a, { ...a, etag: "\"y\"" }), false);
  assert.equal(sameValidators(a, { ...a, etag: "W/\"x\"" }), true, "weak and strong forms of one tag");
  assert.equal(sameValidators(a, { ...a, lastModified: "M" }), false);
  assert.equal(sameValidators(a, { size: 10, etag: null, lastModified: "L" }), false, "a tag that disappeared is a change");
  assert.equal(sameValidators({ size: 10 }, { size: 10 }), true, "a server with neither is judged by size");
});

test("the cache key is stable per URL and differs between URLs", () => {
  const key = discCacheKey("http://a/disc/x.rvz");
  assert.match(key, /^disc-[0-9a-f]{16}$/);
  assert.equal(discCacheKey("http://a/disc/x.rvz"), key);
  assert.notEqual(discCacheKey("http://a/disc/y.rvz"), key);
});

test("a fresh copy zeroes its bitmap before sizing the image, and names its source last", async () => {
  const root = new FakeDirectory();
  const src = source();
  const { store, reason, note } = await openStore(root, src);
  assert.equal(reason, null);
  assert.equal(note, null);
  const files = cacheFiles(root, src);
  assert.equal(files.img.size, src.size, "the image is sized up front (sparse); its size proves nothing");
  assert.equal(files.map.size, Math.ceil(blockCount(src.size) / 8));
  const meta = JSON.parse(new TextDecoder().decode(files.meta.bytes()));
  assert.equal(meta.url, src.url);
  assert.equal(meta.size, src.size);
  assert.equal(meta.etag, src.etag);
  assert.equal(meta.lastModified, src.lastModified);
  assert.equal(meta.storedBytes, 0);

  const order = root.log.map(([op, name]) => `${op}:${name.split(".").pop()}`);
  const zeroed = order.indexOf("write:map");
  const sized = order.lastIndexOf("truncate:img");
  const named = order.indexOf("write:json");
  assert.ok(zeroed >= 0 && zeroed < sized && sized < named, order.join(" "));
  store.close();
});

test("a block's bytes are flushed before the bitmap that marks it; a reopen resumes the bits", async () => {
  const root = new FakeDirectory();
  const src = source();
  const { store } = await openStore(root, src);
  root.log.length = 0;
  store.write(1, blockOf(src, 1));
  assert.equal(store.has(1), true, "readable at once through the same handle");
  assert.equal(cacheFiles(root, src).map.bytes()[0], 0, "not yet in the bitmap file");
  store.persist();
  const ops = root.log.map(([op, name]) => `${op}:${name.split(".").pop()}`);
  assert.deepEqual(ops, ["write:img", "flush:img", "write:map", "flush:map"]);
  assert.equal(cacheFiles(root, src).map.bytes()[0], 0b010);
  assert.equal(store.storedBytes, B);
  store.write(2, blockOf(src, 2));
  assert.equal(store.storedBytes, B + B / 2, "the short last block counts its own length");
  assert.throws(() => store.write(0, new Uint8Array(10)), RangeError);
  await store.close();

  const again = await openStore(root, src);
  assert.equal(again.reason, null);
  assert.match(again.note, /resuming/);
  assert.equal(again.store.has(1), true);
  assert.equal(again.store.has(2), true, "close() persisted the last block");
  assert.equal(again.store.has(0), false);
  const view = new Uint8Array(100);
  assert.equal(again.store.read(view, B + 5), 100);
  assert.deepEqual(view, discBytes(B + 5, B + 105));
  again.store.close();
});

test("a changed source discards the copy: size, ETag or Last-Modified", async () => {
  for (const change of [{ size: 3 * B }, { etag: "\"v2\"" }, { lastModified: "Fri, 02 Oct 2026 00:00:00 GMT" }]) {
    const root = new FakeDirectory();
    const { store } = await openStore(root);
    store.write(0, blockOf(source(), 0));
    await store.close();

    const changed = source(change);
    const { store: next, reason, note } = await openStore(root, changed);
    assert.equal(reason, null);
    assert.match(note, /changed/, JSON.stringify(change));
    assert.equal(next.has(0), false, "the old block is not served for the new disc");
    assert.equal(next.bitmap.present, 0);
    const files = cacheFiles(root, changed);
    assert.equal(files.img.size, changed.size);
    assert.deepEqual(files.img.bytes(0, 16), new Uint8Array(16), "the old bytes are gone, not just unreferenced");
    assert.equal(JSON.parse(new TextDecoder().decode(files.meta.bytes())).size, changed.size);
    next.close();
  }
});

test("an evicted image or bitmap starts over instead of failing", async () => {
  for (const lost of ["img", "map"]) {
    const root = new FakeDirectory();
    const src = source();
    const { store } = await openStore(root, src);
    store.write(0, blockOf(src, 0));
    await store.close();
    const files = cacheFiles(root, src);
    await files.dir.removeEntry(files[lost].name);

    const { store: next, reason, note } = await openStore(root, src);
    assert.equal(reason, null, lost);
    assert.match(note, /evicted|incomplete/);
    assert.equal(next.bitmap.present, 0, `${lost} missing: nothing is trusted`);
    next.close();
  }

  const root = new FakeDirectory();
  const src = source();
  const { store } = await openStore(root, src);
  await store.close();
  cacheFiles(root, src).img.resize(B);             // a truncated image
  const { store: next } = await openStore(root, src);
  assert.equal(next.bitmap.present, 0);
  assert.equal(cacheFiles(root, src).img.size, src.size);
  next.close();
});

test("unreadable metadata starts over", async () => {
  const root = new FakeDirectory();
  const src = source();
  const { store } = await openStore(root, src);
  store.write(0, blockOf(src, 0));
  await store.close();
  const meta = cacheFiles(root, src).meta;
  meta.resize(0);
  meta.writeAt(0, new TextEncoder().encode("{\"v\":1,\"url\""));
  const { store: next, reason } = await openStore(root, src);
  assert.equal(reason, null);
  assert.equal(next.bitmap.present, 0);
  next.close();
});

test("a disc that won't fit keeps streaming and says why", async () => {
  const root = new FakeDirectory();
  const src = source();
  const { store, reason } = await OpfsDiscStore.open({
    root, source: src, estimate: async () => ({ usage: 0, quota: src.size })
  });
  assert.equal(store, null);
  assert.match(reason, /not enough space on this device/);
  assert.equal(cacheFiles(root, src).img, null, "nothing is left behind");

  const quota = new FakeDirectory();
  const dir = await quota.getDirectoryHandle(DISC_CACHE_DIR, { create: true });
  (await dir.getFileHandle(`${discCacheKey(src.url)}.img`, { create: true })).file.quota = B;
  const refused = await OpfsDiscStore.open({ root: quota, source: src });
  assert.equal(refused.store, null);
  assert.match(refused.reason, /not enough space/);
});

test("a copy held by another tab streams instead", async () => {
  const root = new FakeDirectory();
  const src = source();
  const first = await openStore(root, src);
  const second = await openStore(root, src);
  assert.equal(second.store, null);
  assert.match(second.reason, /open in another tab/);
  first.store.close();
});

test("a backend that ignores truncate (Chromium's in-memory one) streams rather than serve zeros", async () => {
  const root = new FakeDirectory();
  const src = source();
  const dir = await root.getDirectoryHandle(DISC_CACHE_DIR, { create: true });
  (await dir.getFileHandle(`${discCacheKey(src.url)}.img`, { create: true })).file.silentTruncate = true;
  const { store, reason } = await openStore(root, src);
  assert.equal(store, null);
  assert.match(reason, /not enough space|could not/);

  const writes = new FakeDirectory();
  const opened = await openStore(writes, src);
  cacheFiles(writes, src).img.failWrite = true;
  assert.throws(() => opened.store.write(0, blockOf(src, 0)), /short write/);
  assert.equal(opened.store.has(0), false, "a failed write sets no bit");
  opened.store.close();
});

test("the listing, removal, and the page's header read from this device", async () => {
  const root = new FakeDirectory();
  assert.deepEqual(await listCachedDiscs(root), []);
  const src = source();
  const { store } = await openStore(root, src);
  store.write(0, blockOf(src, 0));
  await store.close();
  const other = source({ url: "http://127.0.0.1:8085/disc/other.iso", name: "other.iso", size: B });
  const second = await openStore(root, other);
  second.store.write(0, blockOf(other, 0));
  await second.store.close();

  const listed = await listCachedDiscs(root);
  assert.equal(listed.length, 2);
  const game = listed.find((d) => d.name === "game.rvz");
  assert.equal(game.storedBytes, B);
  assert.equal(game.size, src.size);
  assert.equal(game.complete, false);
  assert.equal(listed.find((d) => d.name === "other.iso").complete, true);

  const header = await readCachedRange(root, src, 0, 0x8010);
  assert.deepEqual(header, discBytes(0, 0x8010));
  assert.equal(await readCachedRange(root, src, B - 10, B + 10), null, "block 1 is not here");
  assert.equal(await readCachedRange(root, { ...src, etag: "\"v2\"" }, 0, 16), null, "another version");
  const entry = await readCachedDiscEntry(root, src);
  assert.equal(entry.matches, true);
  assert.equal(entry.storedBytes, B);
  assert.equal((await readCachedDiscEntry(root, { ...src, size: 1 })).matches, false);

  const held = await openStore(root, src);
  await assert.rejects(removeCachedDisc(root, discCacheKey(src.url)), { name: "NoModificationAllowedError" });
  held.store.close();
  await removeCachedDisc(root, discCacheKey(src.url));
  assert.deepEqual((await listCachedDiscs(root)).map((d) => d.name), ["other.iso"]);

  // A crash before the metadata was written leaves an image the listing still offers.
  const dir = root.dir(DISC_CACHE_DIR);
  (await dir.getFileHandle("disc-0000000000000000.img", { create: true })).file.resize(123);
  const orphan = (await listCachedDiscs(root)).find((d) => d.key === "disc-0000000000000000");
  assert.equal(orphan.storedBytes, null);
  assert.equal(orphan.size, 123);
});

async function cachedDisc({ src = source(), prefetch = true, root = new FakeDirectory(), timers = manualTimers() } = {}) {
  const fetcher = fakeFetcher(src);
  const disc = await openRangeDisc(src, {
    opfs: true,
    prefetch,
    getRoot: async () => root,
    estimate: roomy,
    createFetcher: () => fetcher,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });
  return { disc, fetcher, root, src, timers };
}

function read(disc, start, end) {
  const { size, buffer } = disc.slice(start, end);
  assert.equal(size, end - start);
  return new Uint8Array(buffer);
}

test("a read checks L1, then L2, then L3; a block from L3 lands in L1 and in L2", async () => {
  const { disc, fetcher, root, src } = await cachedDisc();
  assert.equal(disc.stats.mode, "cached");

  assert.deepEqual(read(disc, 100, 200), discBytes(100, 200));
  assert.deepEqual(fetcher.demands, [0], "the first read waits on the network");
  assert.equal(disc.stats.waits, 1);
  assert.equal(disc.store.has(0), true, "and its block is written to this device");
  assert.equal(disc.blocks.has(0), true);

  root.log.length = 0;
  assert.deepEqual(read(disc, 300, 400), discBytes(300, 400));
  assert.equal(disc.stats.l1Hits, 1, "the second read of the block is served from memory");
  assert.equal(root.log.filter(([op]) => op === "read").length, 0);

  disc.blocks.clear();                              // L1 forgets; L2 still has it
  assert.deepEqual(read(disc, 500, 600), discBytes(500, 600));
  assert.equal(disc.stats.l2Hits, 1);
  assert.deepEqual(fetcher.demands, [0], "no second network read");
  assert.deepEqual(root.log.filter(([op]) => op === "read").map(([, , at, n]) => [at, n]), [[500, 100]],
    "L2 reads exactly the bytes asked for");

  // A slice across a block boundary: block 0 from L2, block 1 from L3.
  disc.blocks.clear();
  assert.deepEqual(read(disc, B - 50, B + 50), discBytes(B - 50, B + 50));
  assert.deepEqual(fetcher.demands, [0, 1]);
  assert.equal(disc.stats.l2Hits, 2);

  // The last, short block and a slice past the end.
  const tail = disc.slice(src.size - 10, src.size + 99);
  assert.equal(tail.size, 10);
  assert.deepEqual(new Uint8Array(tail.buffer), discBytes(src.size - 10, src.size));
  await disc.close();
  assert.equal(fetcher.closed, true);
});

test("an L2 read that comes back short drops to streaming and refetches", async () => {
  const { disc, fetcher, root, src } = await cachedDisc();
  read(disc, 0, 10);
  disc.blocks.clear();
  cacheFiles(root, src).img.failRead = true;
  assert.deepEqual(read(disc, 20, 30), discBytes(20, 30));
  assert.deepEqual(fetcher.demands, [0, 0]);
  assert.equal(disc.stats.mode, "streaming");
  assert.match(disc.stats.reason, /reading the copy on this device failed/);
  assert.equal(fetcher.sequential.at(-1)[0], false, "no sequential stream without somewhere to put it");
  assert.equal(disc.fetcher.bitmapBytes, null);
  await disc.close();
});

test("background blocks: sequential ones go to L2 only, blocks ahead to L1 and L2", async () => {
  const { disc, fetcher } = await cachedDisc();
  fetcher.ready.push([1, KIND_SEQUENTIAL], [2, KIND_AHEAD]);
  disc.consumeReady();
  assert.equal(disc.store.has(1), true);
  assert.equal(disc.blocks.has(1), false, "the whole disc passing through would flush L1");
  assert.equal(disc.store.has(2), true);
  assert.equal(disc.blocks.has(2), true);
  assert.notEqual(disc.blocks.get(2).buffer, undefined);
  await disc.close();
});

test("the sequential stream: on with a copy here, capped while the game runs, off when done or disabled", async () => {
  const { disc, fetcher, src } = await cachedDisc();
  assert.deepEqual(fetcher.sequential, [[true, 0]], "unlimited before the boot");
  disc.setGameRunning(true);
  assert.deepEqual(fetcher.sequential.at(-1), [true, SEQUENTIAL_CAP_WHILE_RUNNING]);
  disc.setGameRunning(true);
  assert.equal(fetcher.sequential.length, 2, "no repeated message");
  for (let i = 0; i < blockCount(src.size); i++) {
    fetcher.ready.push([i, KIND_SEQUENTIAL]);
  }
  disc.consumeReady();
  assert.equal(disc.stats.complete, true);
  assert.equal(disc.stats.sequential, "done");
  assert.deepEqual(fetcher.sequential.at(-1), [false, SEQUENTIAL_CAP_WHILE_RUNNING]);
  await disc.close();

  const off = await cachedDisc({ prefetch: false });
  assert.deepEqual(off.fetcher.sequential, [[false, 0]], "?prefetch=0");
  read(off.disc, 0, 10);
  assert.equal(off.disc.store.has(0), true, "misses still land on this device");
  await off.disc.close();

  const streaming = fakeFetcher(source());
  const noStore = await openRangeDisc(source(), { opfs: false, createFetcher: () => streaming });
  assert.equal(noStore.stats.mode, "streaming");
  assert.match(noStore.stats.reason, /\?opfs=0/);
  assert.deepEqual(streaming.sequential, [[false, 0]], "?opfs=0: nowhere to put a sequential stream");
  await noStore.close();
});

test("?recordreads=1: the blocks the core read, first touch first, each once, with when", async () => {
  const src = source();
  const fetcher = fakeFetcher(src);
  let now = 0;
  const disc = new RangeDisc({ ...src }, { fetcher, recordReads: true, now: () => now });
  read(disc, 2 * B + 10, 2 * B + 20);
  now = 1500;
  read(disc, B - 5, B + 5);                  // blocks 0 and 1, in that order
  read(disc, 2 * B, 2 * B + 1);              // 2 again: not again
  assert.deepEqual(disc.readOrder(), { v: 1, name: src.name, size: src.size, block: B, blocks: [2, 0, 1], seconds: [0, 1.5, 1.5] });
  assert.equal(disc.stats.recorded, 3);
  const off = new RangeDisc({ ...src }, { fetcher: fakeFetcher(src) });
  read(off, 0, 10);
  assert.equal(off.readOrder(), null, "not recording unless asked");
  assert.equal(off.stats.recorded, null);
});

test("a read order beside the disc goes to the fetcher, without holding up the open; none without a sequential stream", async () => {
  const src = source();
  const fetcher = fakeFetcher(src);
  fetcher.orders = [];
  fetcher.setOrder = (blocks) => fetcher.orders.push(blocks);
  let answer;
  const asked = [];
  const disc = await openRangeDisc(src, {
    opfs: true, getRoot: async () => new FakeDirectory(), estimate: roomy, createFetcher: () => fetcher,
    loadOrder: (s) => { asked.push(s.url); return new Promise((resolve) => { answer = resolve; }); }
  });
  assert.deepEqual(asked, [src.url]);
  assert.equal(disc.stats.readOrder, null, "open did not wait for it");
  answer({ blocks: [2, 1], reason: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fetcher.orders, [[2, 1]]);
  assert.deepEqual(disc.stats.readOrder, { blocks: 2, from: "game.rvz.reads.json" });
  await disc.close();

  const none = fakeFetcher(src);
  none.setOrder = () => assert.fail("no order without one");
  const plain = await openRangeDisc(src, {
    opfs: true, getRoot: async () => new FakeDirectory(), estimate: roomy, createFetcher: () => none,
    loadOrder: async () => ({ blocks: null, reason: null })
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(plain.stats.readOrder, null, "a 404: nothing changes");
  await plain.close();

  const logs = [];
  const streaming = await openRangeDisc(src, {
    opfs: false, createFetcher: () => fakeFetcher(src), log: (m) => logs.push(m),
    loadOrder: () => assert.fail("not fetched: nothing would use it")
  });
  assert.ok(logs.some((m) => /no read order: no sequential stream \(turned off \(\?opfs=0\)\)/.test(m)), logs.join(" | "));
  await streaming.close();
});

test("progress is persisted on a timer and the whole copy survives a reopen", async () => {
  const root = new FakeDirectory();
  const timers = manualTimers();
  const first = await cachedDisc({ root, timers });
  read(first.disc, 0, 10);
  assert.equal(timers.pending, 1, "a persist is scheduled");
  timers.runAll();
  assert.equal(cacheFiles(root).map.bytes()[0], 0b001);
  await first.disc.close();

  const second = await cachedDisc({ root });
  assert.equal(second.disc.store.has(0), true);
  assert.equal(second.disc.stats.storedBytes, B);
  read(second.disc, 0, 10);
  assert.deepEqual(second.fetcher.demands, [], "a second launch reads the block from this device");
  await second.disc.close();
});

test("one block ahead of each read, asked once per block, never for a block already here", async () => {
  const { disc, fetcher } = await cachedDisc();
  read(disc, 0, 10);
  read(disc, 10, 20);
  assert.deepEqual(fetcher.aheads, [1]);
  disc.store.write(2, blockOf(source(), 2));
  read(disc, B, B + 10);
  assert.deepEqual(fetcher.aheads, [1], "block 2 is on this device");
  await disc.close();
});

test("a changed source drops and removes the copy", async () => {
  const { disc, fetcher, root, src } = await cachedDisc();
  read(disc, 0, 10);
  fetcher.changed = true;
  disc.consumeReady();
  assert.equal(disc.stats.mode, "streaming");
  assert.match(disc.stats.reason, /changed on the server/);
  assert.equal(disc.blocks.size, 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cacheFiles(root, src).img, null);
  await disc.close();
});

test("remove from this device: the copy goes, the disc keeps streaming", async () => {
  const { disc, fetcher, root, src } = await cachedDisc();
  read(disc, 0, 10);
  await disc.removeFromDevice();
  assert.equal(cacheFiles(root, src).img, null);
  assert.equal(disc.stats.mode, "streaming");
  assert.equal(disc.stats.reason, "removed from this device");
  disc.blocks.clear();
  read(disc, 0, 10);
  assert.deepEqual(fetcher.demands, [0, 0]);
  await disc.close();
});

test("read errors go through readError, so WORKERFS can see an errno instead of a crash", async () => {
  const src = source();
  const fetcher = fakeFetcher(src);
  fetcher.demand = () => { throw new Error("disc block 0: HTTP 503"); };
  const disc = new RangeDisc(src, { fetcher, readError: (error) => Object.assign(new Error("EIO"), { cause: error }) });
  assert.throws(() => disc.slice(0, 10), (error) => error.message === "EIO" && /503/.test(error.cause.message));
});

test("L1 keeps the most recent blocks", async () => {
  const src = source({ size: (RANGE_CACHE_BLOCKS + 2) * B });
  const fetcher = fakeFetcher(src);
  fetcher.demand = (i) => ({ bytes: new Uint8Array(1), waited: true });
  const disc = new RangeDisc(src, { fetcher });
  for (let i = 0; i < RANGE_CACHE_BLOCKS + 2; i++) disc.keep(i, new Uint8Array(1));
  assert.equal(disc.blocks.size, RANGE_CACHE_BLOCKS);
  assert.equal(disc.blocks.has(0), false);
  assert.equal(disc.blocks.has(RANGE_CACHE_BLOCKS + 1), true);
});
