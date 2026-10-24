// The copy on this device written by the fetch worker (shared sync handles + a Web Lock),
// read by the discio worker: who writes, who reads, and how a lost or removed copy is
// handed back.
import assert from "node:assert/strict";
import test from "node:test";

import { BlockBitmap, DISC_CACHE_DIR, KIND_DEMAND, discCacheKey, openRangeDisc } from "../src/remote-disc.js";
import {
  DEMAND_DONE,
  DEMAND_WAITING,
  DiscFetcher,
  demandWord,
  fetchSharedLayout,
  openWriterStore
} from "../src/remote-disc-fetch.js";
import { FakeDirectory, FakeLocks } from "./helpers/fake-opfs.mjs";

const SIZE = 100;
const BLOCK = 16;
const byteAt = (o) => (o * 29 + 3) & 0xff;
const source = { url: "http://h/disc/w.iso", name: "w.iso", size: SIZE, etag: "\"w1\"", lastModified: null };
const roomy = async () => ({ usage: 0, quota: 1e9 });
const settle = () => new Promise((resolve) => setImmediate(resolve));

function expected(start, end) {
  const out = new Uint8Array(end - start);
  for (let i = 0; i < out.length; i++) out[i] = byteAt(start + i);
  return out;
}

function shared() {
  const layout = fetchSharedLayout({ size: SIZE, blockSize: BLOCK });
  const buffer = new SharedArrayBuffer(layout.byteLength);
  return { layout, buffer, bitmapBytes: new Uint8Array(buffer, layout.bitmapOffset, layout.bitmapBytes) };
}

function files(root) {
  const dir = root.dir(DISC_CACHE_DIR);
  const key = discCacheKey(source.url);
  return { dir, img: dir?.file(`${key}.img`), map: dir?.file(`${key}.map`), meta: dir?.file(`${key}.json`) };
}

function network() {
  const calls = [];
  const fetchStream = (url, start, end, signal, onChunk) => new Promise((resolve, reject) => {
    const call = {
      start,
      settled: false,
      finish() {
        onChunk(expected(start, end + 1));
        call.settled = true;
        resolve({ status: 206, total: SIZE, etag: null, lastModified: null });
      }
    };
    signal.addEventListener("abort", () => { call.settled = true; reject(new DOMException("aborted", "AbortError")); });
    calls.push(call);
  });
  return { calls, fetchStream, live: () => calls.filter((c) => !c.settled) };
}

async function writerSetup({ root = new FakeDirectory(), locks = new FakeLocks() } = {}) {
  const sh = shared();
  const opened = await openWriterStore({ source, bitmapBytes: sh.bitmapBytes, getRoot: async () => root, estimate: roomy, locks, blockSize: BLOCK });
  assert.equal(opened.ok, true, opened.reason);
  const net = network();
  const posted = [];
  const ready = [];
  const timers = [];
  const fetcher = new DiscFetcher({
    url: source.url,
    size: SIZE,
    blockSize: BLOCK,
    buffer: sh.buffer,
    layout: sh.layout,
    fetchStream: net.fetchStream,
    notifyReady: () => ready.push(true),
    post: (m) => posted.push(m),
    store: opened.store,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {}
  });
  const ctl = new Int32Array(sh.buffer, 0, sh.layout.ctlInts);
  const bitmap = new BlockBitmap(sh.layout.blocks, sh.bitmapBytes);
  return { ...sh, root, locks, store: opened.store, fetcher, net, posted, ready, timers, ctl, bitmap };
}

test("the fetch worker's copy: shared image handle, one tab at a time by Web Lock", async () => {
  const root = new FakeDirectory();
  const locks = new FakeLocks();
  const sh = shared();
  const args = { source, bitmapBytes: sh.bitmapBytes, getRoot: async () => root, estimate: roomy, locks, blockSize: BLOCK };
  const first = await openWriterStore(args);
  assert.equal(first.ok, true);
  assert.equal(first.writer, true);
  assert.equal(first.store.shared, true);
  assert.equal(files(root).img.shared, 1, "the image is held shared, so a reader can open beside it");

  const second = await openWriterStore(args);
  assert.deepEqual([second.ok, second.writer], [false, true]);
  assert.match(second.reason, /open in another tab/, "shared handles would let a second tab in; the lock doesn't");

  await first.store.close();
  first.store.release();
  await settle();
  const third = await openWriterStore(args);
  assert.equal(third.ok, true, "released with the store");
  await third.store.close();
  third.store.release();
  await settle();

  const ignoring = new FakeDirectory();
  ignoring.sharedModes = false;
  const fallback = await openWriterStore({ ...args, getRoot: async () => ignoring });
  assert.deepEqual([fallback.ok, fallback.writer], [false, false], "no shared handles: the discio worker owns the copy");
  await settle();
  assert.equal(locks.held.size, 0);
  assert.equal(files(ignoring).img.locked, false, "and the probe's handle is closed again");

  const noLocks = await openWriterStore({ ...args, locks: undefined });
  assert.deepEqual([noLocks.ok, noLocks.writer], [false, false]);
});

test("the fetch worker writes every block it fetches; the discio worker is handed none", async () => {
  const t = await writerSetup();
  t.fetcher.handle({ type: "sequential", on: true, cap: 0 });
  for (const call of t.net.live()) call.finish();
  await settle();
  assert.equal(t.bitmap.has(0) && t.bitmap.has(1), true);
  assert.equal(t.ready.length, 0, "nothing to take from a slot: the blocks are on this device already");
  assert.deepEqual(files(t.root).img.bytes(0, 32), expected(0, 32));
  assert.ok(t.timers.some((timer) => timer.ms === 5000), "progress is persisted on a timer");

  // A miss: answered first, written after.
  t.fetcher.handle({ type: "sequential", on: false, cap: 0 });
  Atomics.store(t.ctl, 0, demandWord(1, DEMAND_WAITING));
  t.fetcher.handle({ type: "demand", block: 5, seq: 1 });
  t.net.calls.find((c) => c.start === 80).finish();
  await settle();
  assert.equal(Atomics.load(t.ctl, 0), demandWord(1, DEMAND_DONE));
  assert.equal(t.bitmap.has(5), true);
  assert.deepEqual(files(t.root).img.bytes(80, 96), expected(80, 96));

  t.fetcher.handle({ type: "sequential", on: true, cap: 0 });
  for (let round = 0; round < 6 && !t.bitmap.complete; round++) {
    for (const call of t.net.live()) call.finish();
    await settle();
  }
  t.bitmap.recount();
  assert.equal(t.bitmap.complete, true);
  assert.equal(Atomics.load(t.ctl, 4) & 4, 4, "the discio worker can see the copy is complete");
  assert.deepEqual(files(t.root).map.bytes(), Uint8Array.of(0x7f), "and it was persisted at once (seven blocks)");
  await settle();
  assert.equal(JSON.parse(new TextDecoder().decode(files(t.root).meta.bytes())).complete, true);
  assert.deepEqual(files(t.root).img.bytes(), expected(0, SIZE));
});

test("a copy the fetch worker can no longer write is handed back: flag, reason, bits cleared", async () => {
  const t = await writerSetup();
  t.fetcher.handle({ type: "sequential", on: true, cap: 0 });
  t.net.live()[0].finish();
  await settle();
  assert.equal(t.bitmap.has(0), true);
  files(t.root).img.failWrite = true;
  t.net.live()[0].finish();
  await settle();
  assert.equal(Atomics.load(t.ctl, 4) & 2, 2);
  assert.match(t.posted.find((m) => m.type === "storeLost").reason, /writing to this device failed/);
  assert.equal(t.bitmap.recount(), 0, "nothing is skipped that is no longer readable");
  const calls = t.net.calls.length;
  await settle();
  assert.equal(t.net.calls.length, calls, "no sequential stream without somewhere to put it");
});

test("remove from this device: the fetch worker closes and removes the copy, then lets go of the lock", async () => {
  const t = await writerSetup();
  t.fetcher.handle({ type: "sequential", on: true, cap: 0 });
  t.net.live()[0].finish();
  await settle();
  await t.fetcher.handle({ type: "dropStore", remove: true });
  assert.equal(files(t.root).img, null);
  assert.equal(files(t.root).map, null);
  assert.equal(files(t.root).meta, null);
  assert.ok(t.posted.some((m) => m.type === "storeDropped"));
  await settle();
  assert.equal(t.locks.held.size, 0);
});

test("the discio worker reads the fetch worker's copy and writes nothing", async () => {
  const root = new FakeDirectory();
  const locks = new FakeLocks();
  const big = { ...source, size: 3 * 4 * 1024 * 1024 };
  const layout = fetchSharedLayout({ size: big.size });
  const buffer = new SharedArrayBuffer(layout.byteLength);
  const bitmapBytes = new Uint8Array(buffer, layout.bitmapOffset, layout.bitmapBytes);
  const writer = await openWriterStore({ source: big, bitmapBytes, getRoot: async () => root, estimate: roomy, locks });
  const block = (i) => new Uint8Array(4 * 1024 * 1024).fill(i + 1);
  const order = [];
  const fetcher = {
    kind: "fake",
    bitmapBytes,
    storeReport: { ok: true, writer: true, reason: null, note: null },
    storeLost: null,
    storeComplete: false,
    changed: false,
    onReady: null,
    sequential: [],
    demand(i) {                      // as the fetch worker: answer, then write the copy
      const bytes = block(i);
      writer.store.write(i, bytes);
      return { bytes, waited: true };
    },
    ahead() {},
    drainReady() {},
    setSequential(on, cap) { this.sequential.push([on, cap]); },
    counters: () => ({ bytes: 0, requests: 0, salvaged: 0, aborts: 0 }),
    sequentialState: () => "running",
    async dropStore({ remove }) {
      order.push(["dropStore", remove, files(root).img.shared]);
      await writer.store[remove ? "remove" : "close"]();
    },
    async close() {}
  };
  const disc = await openRangeDisc(big, { opfs: true, getRoot: async () => root, createFetcher: () => fetcher });
  assert.equal(disc.stats.mode, "cached");
  assert.equal(disc.stats.writer, "fetch worker");
  assert.equal(files(root).img.shared, 2, "writer and reader side by side");

  const first = new Uint8Array(disc.slice(10, 20).buffer);
  assert.deepEqual(first, new Uint8Array(10).fill(1));
  assert.equal(disc.stats.mode, "cached", "the discio worker did not try to write the block itself");
  disc.blocks.clear();
  assert.deepEqual(new Uint8Array(disc.slice(30, 40).buffer), new Uint8Array(10).fill(1));
  assert.equal(disc.stats.l2Hits, 1, "read through its own shared handle");
  assert.equal(disc.stats.storedBlocks, 1, "counted from the shared bitmap");

  fetcher.storeComplete = true;
  disc.consumeReady();
  assert.equal(disc.completeSeen, true);
  assert.deepEqual(fetcher.sequential.at(-1)[0], false, "the stream stops once the copy is whole");

  await disc.removeFromDevice();
  assert.deepEqual(order, [["dropStore", true, 1]], "the reader let go before the fetch worker removed the files");
  assert.equal(files(root).img, null);
  assert.equal(disc.stats.reason, "removed from this device");
});

test("a copy lost by the fetch worker turns the disc to streaming, with its reason", async () => {
  const root = new FakeDirectory();
  const locks = new FakeLocks();
  const big = { ...source, size: 4 * 1024 * 1024 };
  const layout = fetchSharedLayout({ size: big.size });
  const buffer = new SharedArrayBuffer(layout.byteLength);
  const bitmapBytes = new Uint8Array(buffer, layout.bitmapOffset, layout.bitmapBytes);
  await openWriterStore({ source: big, bitmapBytes, getRoot: async () => root, estimate: roomy, locks });
  let dropped = 0;
  const fetcher = {
    kind: "fake", bitmapBytes, storeReport: { ok: true, writer: true }, storeLost: null, storeComplete: false,
    changed: false, onReady: null, demand: () => ({ bytes: new Uint8Array(4 * 1024 * 1024), waited: true }),
    ahead() {}, drainReady() {}, setSequential() {}, counters: () => ({ bytes: 0, requests: 0, salvaged: 0, aborts: 0 }),
    sequentialState: () => "off", async dropStore() { dropped++; }, async close() {}
  };
  const disc = await openRangeDisc(big, { opfs: true, getRoot: async () => root, createFetcher: () => fetcher });
  fetcher.storeLost = "writing to this device failed (QuotaExceededError)";
  disc.consumeReady();
  assert.equal(disc.stats.mode, "streaming");
  assert.match(disc.stats.reason, /QuotaExceededError/);
  assert.equal(dropped, 0, "the fetch worker already let it go");
  assert.equal(files(root).img.shared, 1, "the reader's handle is closed");

  const refused = { ...fetcher, storeReport: { ok: false, writer: true, reason: "the copy on this device is open in another tab" } };
  const other = await openRangeDisc(big, { opfs: true, getRoot: async () => root, createFetcher: () => refused });
  assert.equal(other.stats.mode, "streaming");
  assert.match(other.stats.reason, /another tab/);
});

test("a demand answered from an async slot is still written to the copy", async () => {
  const t = await writerSetup();
  t.fetcher.handle({ type: "sequential", on: true, cap: 0 });
  Atomics.store(t.ctl, 0, demandWord(1, DEMAND_WAITING));
  t.fetcher.handle({ type: "demand", block: 1, seq: 1 });      // block 1 is already on its way
  const slot = [...t.fetcher.inflight.values()].find((r) => r.block === 1);
  assert.equal(slot.kind, KIND_DEMAND);
  t.net.calls.find((c) => c.start === 16).finish();
  await settle();
  assert.equal(Atomics.load(t.ctl, 0), demandWord(1, DEMAND_DONE));
  assert.equal(t.bitmap.has(1), true);
  assert.deepEqual(files(t.root).img.bytes(16, 32), expected(16, 32));
});
