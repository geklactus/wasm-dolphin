// The demand path answers a read once its window has arrived, not the whole block: the
// window first, the rest of the block after it at demand priority, a later read into the
// block waiting on the same slot, out-of-order blocks resumed from their gaps, and only
// whole blocks ever reaching L1 or L2. Synthetic data only.
import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { BlockBitmap, DISC_CACHE_DIR, KIND_DEMAND, RANGE_BLOCK, discCacheKey, openRangeDisc } from "../src/remote-disc.js";
import {
  DEMAND_DONE,
  DEMAND_IDLE,
  DEMAND_WAITING,
  DiscFetcher,
  FetchWorkerClient,
  INFO_FOLLOW,
  INFO_WAITED,
  INFO_WINDOW,
  SLOT_FILLING,
  SLOT_PARTIAL,
  SLOT_READY,
  addRange,
  demandWord,
  fetchSharedLayout,
  firstMissing,
  nextRange,
  openWriterStore,
  rangeBytes
} from "../src/remote-disc-fetch.js";
import { FakeDirectory, FakeLocks } from "./helpers/fake-opfs.mjs";

const K = 1024;
const BLOCK = 1024 * K;
const SIZE = 3 * BLOCK + BLOCK / 2;     // four blocks, the last one half a block
const byteAt = (o) => (o * 31 + (o >>> 11) + 5) & 0xff;
const settle = () => new Promise((resolve) => setImmediate(resolve));

function expected(start, end) {
  const out = new Uint8Array(end - start);
  for (let i = 0; i < out.length; i++) out[i] = byteAt(start + i);
  return out;
}

// A streaming response per Range request, driven by the test: push(n) hands over the
// next n bytes as one chunk, finish() ends the body.
function fakeNetwork(size) {
  const calls = [];
  const fetchStream = (url, start, end, signal, onChunk) => new Promise((resolve, reject) => {
    const call = {
      start,
      end,
      signal,
      sent: 0,
      settled: false,
      push(n = end - start + 1 - call.sent) {
        n = Math.min(n, end - start + 1 - call.sent);
        call.sent += n;
        onChunk(expected(start + call.sent - n, start + call.sent));
      },
      finish(meta = {}) {
        call.settled = true;
        resolve({ status: 206, etag: null, lastModified: null, total: size, ...meta });
      },
      all() {
        call.push();
        call.finish();
      }
    };
    signal.addEventListener("abort", () => {
      call.settled = true;
      reject(new DOMException("aborted", "AbortError"));
    });
    calls.push(call);
  });
  const live = () => calls.filter((call) => !call.settled);
  return { calls, fetchStream, live, ranges: () => live().map((c) => [c.start, c.end]) };
}

const quietPort = { addEventListener() {}, postMessage() {} };

function setup({ size = SIZE, blockSize = BLOCK, store = null, ...options } = {}) {
  const layout = fetchSharedLayout({ size, blockSize });
  const buffer = new SharedArrayBuffer(layout.byteLength);
  const net = fakeNetwork(size);
  const ready = [];
  let clock = 0;
  const fetcher = new DiscFetcher({
    url: "http://disc/",
    size,
    blockSize,
    buffer,
    layout,
    store,
    fetchStream: net.fetchStream,
    notifyReady: () => ready.push(true),
    now: () => clock,
    setTimer: () => 0,
    clearTimer: () => {},
    ...options
  });
  const ctl = new Int32Array(buffer, 0, layout.ctlInts);
  const reader = new FetchWorkerClient({ buffer, layout, port: quietPort });   // to read the counters by name
  const slot = (s) => ({
    state: Atomics.load(ctl, 8 + s * 4),
    block: Atomics.load(ctl, 8 + s * 4 + 1),
    got: Atomics.load(ctl, 8 + s * 4 + 2),
    kind: Atomics.load(ctl, 8 + s * 4 + 3)
  });
  const slotBytes = (s, a, b) => new Uint8Array(buffer, layout.dataOffset + s * blockSize + a, b - a).slice();
  let seq = 0;
  return {
    fetcher, net, ready, ctl, layout, buffer, slot, slotBytes,
    advance(ms) { clock += ms; },
    demand(block, from, len) {
      seq += 1;
      Atomics.store(ctl, 0, demandWord(seq, DEMAND_WAITING));
      fetcher.handle({ type: "demand", block, from, len, seq });
    },
    state: () => Atomics.load(ctl, 0) & 3,
    info: () => Atomics.load(ctl, 6),
    answered: () => Atomics.load(ctl, 1),
    // What the discio worker does once it has copied the window out.
    take() { Atomics.store(ctl, 0, demandWord(seq, DEMAND_IDLE)); },
    counters: () => reader.counters(),
    link: () => reader.link()
  };
}

test("ranges: merged as they arrive, the first missing byte, the next range to ask for", () => {
  const r = [];
  addRange(r, 100, 200);
  addRange(r, 300, 400);
  assert.deepEqual(r, [[100, 200], [300, 400]]);
  addRange(r, 200, 250);
  assert.deepEqual(r, [[100, 250], [300, 400]], "adjacent ranges merge");
  addRange(r, 240, 310);
  assert.deepEqual(r, [[100, 400]]);
  addRange(r, 0, 10);
  assert.equal(rangeBytes(r), 310);
  assert.equal(firstMissing(r, 0, 10), -1);
  assert.equal(firstMissing(r, 0, 50), 10);
  assert.equal(firstMissing(r, 150, 400), -1);
  assert.equal(firstMissing(r, 150, 401), 400);

  const len = 1000;
  assert.deepEqual(nextRange([], len, null, 64), [0, 1000]);
  assert.deepEqual(nextRange([], len, 500, 64), [448, 1000], "a window first, aligned down");
  assert.deepEqual(nextRange([], len, 30, 64), [0, 1000], "a window in the first unit starts at 0");
  assert.deepEqual(nextRange([[448, 1000]], len, 500, 64), [0, 448], "the window's gap filled: the start");
  assert.deepEqual(nextRange([[0, 100], [448, 600]], len, 500, 64), [600, 1000], "the gap after the window first");
  assert.deepEqual(nextRange([[0, 100], [448, 600]], len, 470, 64), [600, 1000]);
  assert.deepEqual(nextRange([[0, 100], [448, 600]], len, 200, 64), [192, 448], "aligned, never before the gap");
  assert.deepEqual(nextRange([[0, 100], [448, 600]], len, 120, 64), [100, 448]);
  assert.deepEqual(nextRange([[0, 1000]], len, 0, 64), null, "whole");
});

test("a read is answered once its window has arrived: at the start, middle and end of a block", async () => {
  // The start: the first 100 KiB of block 1.
  {
    const t = setup();
    t.demand(1, 0, 100 * K);
    assert.deepEqual(t.net.ranges(), [[BLOCK, 2 * BLOCK - 1]], "the whole block, from its start");
    const call = t.net.live()[0];
    call.push(64 * K);
    assert.equal(t.state(), DEMAND_WAITING);
    call.push(64 * K);
    assert.equal(t.state(), DEMAND_DONE, "answered at 128 KiB of 1 MiB");
    assert.equal(t.info(), INFO_WINDOW | INFO_WAITED);
    const s = t.answered();
    assert.equal(t.slot(s).state, SLOT_FILLING, "the block is still arriving");
    assert.deepEqual(t.slotBytes(s, 0, 100 * K), expected(BLOCK, BLOCK + 100 * K));
    assert.equal(call.settled, false, "and its request goes on");
    assert.equal(t.counters().windowFirst, 0);
  }

  // The middle: 50 KiB at 500 KiB. Fetched from 448 KiB to the end, then the start.
  {
    const t = setup();
    t.demand(1, 500 * K, 50 * K);
    assert.deepEqual(t.net.ranges(), [[BLOCK + 448 * K, 2 * BLOCK - 1]], "from the window, aligned down to 64 KiB, to the end");
    const call = t.net.live()[0];
    call.push(64 * K);
    assert.equal(t.state(), DEMAND_WAITING, "448-512 KiB is not the window yet");
    call.push(64 * K);
    assert.equal(t.state(), DEMAND_DONE);
    const s = t.answered();
    assert.deepEqual(t.slotBytes(s, 500 * K, 550 * K), expected(BLOCK + 500 * K, BLOCK + 550 * K));
    t.take();
    assert.equal(t.ready.length, 0);
    call.all();
    await settle();
    assert.deepEqual(t.net.ranges(), [[BLOCK, BLOCK + 448 * K - 1]], "then the start of the block");
    assert.equal(t.slot(s).state, SLOT_FILLING);
    t.net.live()[0].all();
    await settle();
    assert.deepEqual([t.slot(s).state, t.slot(s).block, t.slot(s).kind], [SLOT_READY, 1, KIND_DEMAND],
      "whole: offered to the discio worker, as a miss's block always was");
    assert.equal(t.ready.length, 1);
    assert.deepEqual(t.slotBytes(s, 0, BLOCK), expected(BLOCK, 2 * BLOCK));
    assert.deepEqual(t.net.ranges(), [[2 * BLOCK, 3 * BLOCK - 1]], "then the block after it");
    assert.equal(t.counters().windowFirst, 1);
    assert.equal(t.counters().requests, 2);
  }

  // The end of the last, short block: its last 10 KiB.
  {
    const t = setup();
    const len = SIZE - 3 * BLOCK;
    t.demand(3, len - 10 * K, 10 * K);
    assert.deepEqual(t.net.ranges(), [[3 * BLOCK + 448 * K, SIZE - 1]]);
    const call = t.net.live()[0];
    call.push(60 * K);
    assert.equal(t.state(), DEMAND_WAITING);
    call.push(4 * K);
    assert.equal(t.state(), DEMAND_DONE, "the last byte of the disc is in");
    assert.deepEqual(t.slotBytes(t.answered(), len - 10 * K, len), expected(SIZE - 10 * K, SIZE));
  }
});

test("a later read into the same block waits on that block's progress, not a new request", async () => {
  const t = setup();
  t.demand(1, 0, 64 * K);
  const call = t.net.live()[0];
  call.push(64 * K);
  assert.equal(t.state(), DEMAND_DONE);
  t.take();

  t.demand(1, 16 * K, 16 * K);
  assert.equal(t.state(), DEMAND_DONE, "already here: answered at once");
  assert.equal(t.info(), INFO_WINDOW | INFO_FOLLOW, "without waiting");
  t.take();

  t.demand(1, 200 * K, 64 * K);
  assert.equal(t.state(), DEMAND_WAITING);
  assert.equal(t.net.calls.length, 1, "no second request");
  call.push(136 * K);
  assert.equal(t.state(), DEMAND_WAITING);
  call.push(64 * K);
  assert.equal(t.state(), DEMAND_DONE);
  assert.equal(t.info(), INFO_WINDOW | INFO_WAITED | INFO_FOLLOW, "it waited on the block's progress");
  t.take();

  // Far ahead of the request (more than 256 KiB): it restarts at that window.
  t.demand(1, 900 * K, 32 * K);
  assert.equal(call.signal.aborted, true);
  assert.deepEqual(t.net.ranges(), [[BLOCK + 896 * K, 2 * BLOCK - 1]]);
  assert.equal(t.counters().restarts, 1);
  assert.equal(t.counters().aborts, 0, "a restart is not a parked request");
  t.net.live()[0].push(64 * K);
  assert.equal(t.state(), DEMAND_DONE);
  t.take();
  t.net.live()[0].all();
  await settle();
  assert.deepEqual(t.net.ranges(), [[BLOCK + 264 * K, BLOCK + 896 * K - 1]], "then what the restart skipped");
  t.net.live()[0].all();
  await settle();
  const s = t.answered();
  assert.equal(t.slot(s).state, SLOT_READY);
  assert.deepEqual(t.slotBytes(s, 0, BLOCK), expected(BLOCK, 2 * BLOCK));
  assert.equal(t.net.calls.length - 1, 3, "three requests for the block, plus the one ahead");
});

test("a read whose window runs past the request into another gap waits for it, then gets the next range", async () => {
  const t = setup();
  t.demand(1, 600 * K, 8 * K);                        // [576 KiB, 1 MiB) first
  t.net.live()[0].push(128 * K);
  t.take();
  t.demand(1, 300 * K, 8 * K);                        // behind it, in the gap before: restarts there
  assert.deepEqual(t.net.ranges(), [[BLOCK + 256 * K, BLOCK + 576 * K - 1]]);
  t.net.live()[0].push(64 * K);
  t.take();
  assert.equal(t.counters().restarts, 1);
  // 500-720 KiB: the request in flight brings 500-576, then 704-720 is in the gap after 576-704.
  t.demand(1, 500 * K, 220 * K);
  assert.equal(t.net.live().length, 1, "no restart: the request in flight is on its way to the window");
  assert.equal(t.counters().restarts, 1);
  t.net.live()[0].all();
  await settle();
  assert.equal(t.state(), DEMAND_WAITING);
  assert.deepEqual(t.net.ranges(), [[BLOCK + 704 * K, 2 * BLOCK - 1]], "the window's next missing byte, before the start of the block");
  t.net.live()[0].push(16 * K);
  assert.equal(t.state(), DEMAND_DONE);
  assert.deepEqual(t.slotBytes(t.answered(), 500 * K, 720 * K), expected(BLOCK + 500 * K, BLOCK + 720 * K));
});

test("an abort mid-block keeps what came, out of order or not, and a resume fetches only the gaps", async () => {
  const t = setup();
  t.demand(1, 600 * K, 32 * K);                       // window first: 576 KiB onwards
  t.net.live()[0].push(128 * K);
  assert.equal(t.state(), DEMAND_DONE);
  t.take();
  t.demand(2, 0, 16 * K);                             // a read elsewhere parks block 1
  assert.deepEqual(t.slot(0), { state: SLOT_PARTIAL, block: 1, got: 128 * K, kind: KIND_DEMAND },
    "576-704 KiB kept, nothing before it");
  assert.equal(t.counters().aborts, 1);
  t.net.live()[0].all();
  await settle();
  assert.equal(t.state(), DEMAND_DONE);
  t.take();
  t.net.live()[0].all();                              // block 3, the one ahead of the read
  await settle();

  // The sequential stream reaches block 1: only its gaps, from the start.
  t.fetcher.handle({ type: "sequential", on: true, cap: 0 });
  const forBlock1 = () => t.net.live().filter((c) => c.start >= BLOCK && c.end < 2 * BLOCK);
  for (let round = 0; round < 4 && forBlock1().length === 0; round++) {
    for (const c of t.net.live()) c.all();
    await settle();
  }
  assert.deepEqual(forBlock1().map((c) => [c.start, c.end]), [[BLOCK, BLOCK + 576 * K - 1]]);
  assert.equal(t.counters().salvaged, 128 * K, "the parked bytes are salvaged");
  forBlock1()[0].all();
  await settle();
  assert.deepEqual(forBlock1().map((c) => [c.start, c.end]), [[BLOCK + 704 * K, 2 * BLOCK - 1]]);
  forBlock1()[0].all();
  await settle();
  const s = t.fetcher.findSlot(1, SLOT_READY);
  assert.ok(s >= 0);
  assert.deepEqual(t.slotBytes(s, 0, BLOCK), expected(BLOCK, 2 * BLOCK), "whole and right, filled in three pieces");

  // Parked again in its backfill: two ranges and a gap between them.
  const u = setup();
  u.demand(1, 600 * K, 32 * K);
  u.net.live()[0].all();
  await settle();
  assert.equal(u.state(), DEMAND_DONE);
  u.take();
  assert.deepEqual(u.net.ranges(), [[BLOCK, BLOCK + 576 * K - 1]]);
  u.net.live()[0].push(100 * K);
  u.demand(2, 0, 16 * K);
  assert.deepEqual(u.slot(0), { state: SLOT_PARTIAL, block: 1, got: 100 * K + 448 * K, kind: KIND_DEMAND });
  u.net.live()[0].all();
  await settle();
  u.take();
  u.demand(1, 50 * K, 10 * K);                        // back to block 1: its window is here
  assert.equal(u.state(), DEMAND_DONE, "answered from the parked slot at once");
  assert.equal(u.info() & INFO_WAITED, 0);
  u.take();
  assert.deepEqual(u.net.ranges(), [[BLOCK + 100 * K, BLOCK + 576 * K - 1]], "the rest resumes: only the gap");
  u.net.live()[0].all();
  await settle();
  assert.deepEqual(u.slotBytes(0, 0, BLOCK), expected(BLOCK, 2 * BLOCK));
  assert.equal(u.slot(0).state, SLOT_READY);
});

test("a block a read waits on keeps the link to itself until whole; then the block ahead, then the stream", async () => {
  const t = setup();
  t.fetcher.handle({ type: "sequential", on: true, cap: 0 });
  assert.equal(t.net.live().length, 2);
  t.demand(2, 300 * K, 8 * K);
  assert.deepEqual(t.net.ranges(), [[2 * BLOCK + 256 * K, 3 * BLOCK - 1]], "the stream is parked");
  t.net.live()[0].push(64 * K);
  assert.equal(t.state(), DEMAND_DONE);
  t.take();
  t.fetcher.handle({ type: "freed" });
  t.fetcher.handle({ type: "ahead", block: 3 });
  assert.equal(t.net.live().length, 1, "still parked after the answer: the rest of the block first");
  t.net.live()[0].all();
  await settle();
  assert.deepEqual(t.net.ranges(), [[2 * BLOCK, 2 * BLOCK + 256 * K - 1]], "its start");
  t.net.live()[0].all();
  await settle();
  assert.deepEqual(t.net.ranges().map(([a]) => Math.floor(a / BLOCK)), [3, 0], "whole: the block ahead, then the stream resumes");
});

test("L2 only ever gets whole blocks: the fetch worker writes a block a read waited on once it is whole", async () => {
  const root = new FakeDirectory();
  const source = { url: "http://h/disc/window.iso", name: "window.iso", size: SIZE, etag: "\"w\"", lastModified: null };
  const layout = fetchSharedLayout({ size: SIZE, blockSize: BLOCK });
  const buffer = new SharedArrayBuffer(layout.byteLength);
  const bitmapBytes = new Uint8Array(buffer, layout.bitmapOffset, layout.bitmapBytes);
  const opened = await openWriterStore({
    source, bitmapBytes, getRoot: async () => root, estimate: async () => ({ usage: 0, quota: 1e9 }), locks: new FakeLocks(), blockSize: BLOCK
  });
  assert.equal(opened.ok, true, opened.reason);
  const writes = [];
  const write = opened.store.write.bind(opened.store);
  opened.store.write = (index, bytes) => {
    writes.push([index, bytes.length]);
    assert.deepEqual(bytes, expected(index * BLOCK, index * BLOCK + bytes.length), `block ${index} is whole and right`);
    write(index, bytes);
  };
  const net = fakeNetwork(SIZE);
  let seq = 0;
  const fetcher = new DiscFetcher({
    url: source.url, size: SIZE, blockSize: BLOCK, buffer, layout, store: opened.store, fetchStream: net.fetchStream,
    setTimer: () => 0, clearTimer: () => {}
  });
  const ctl = new Int32Array(buffer, 0, layout.ctlInts);
  const bitmap = new BlockBitmap(layout.blocks, bitmapBytes);
  Atomics.store(ctl, 0, demandWord(++seq, DEMAND_WAITING));
  fetcher.handle({ type: "demand", block: 1, from: 700 * K, len: 4 * K, seq });
  net.live()[0].push(128 * K);
  assert.equal(Atomics.load(ctl, 0) & 3, DEMAND_DONE);
  assert.deepEqual(writes, [], "a window answered is not a block written");
  assert.equal(bitmap.has(1), false);
  Atomics.store(ctl, 0, demandWord(seq, DEMAND_IDLE));
  net.live()[0].all();
  await settle();
  assert.deepEqual(writes, [], "nor is the end of the block");
  net.live()[0].push(300 * K);
  Atomics.store(ctl, 0, demandWord(++seq, DEMAND_WAITING));
  fetcher.handle({ type: "demand", block: 2, from: 0, len: 4 * K, seq });   // parks block 1 out of order
  net.live()[0].all();
  await settle();
  assert.deepEqual(writes, [[2, BLOCK]], "block 2, whole");
  assert.equal(bitmap.has(1), false, "block 1 is in pieces in its slot, not on this device");
  Atomics.store(ctl, 0, demandWord(seq, DEMAND_IDLE));
  fetcher.handle({ type: "sequential", on: true, cap: 0 });
  for (let round = 0; round < 12 && !bitmap.complete; round++) {
    for (const call of net.live()) call.all();
    await settle();
  }
  bitmap.recount();
  assert.equal(bitmap.complete, true);
  assert.deepEqual(writes.map(([i]) => i).sort(), [0, 1, 2, 3], "each block written once");
  assert.ok(writes.every(([i, n]) => n === Math.min(BLOCK, SIZE - i * BLOCK)));
  const img = root.dir(DISC_CACHE_DIR).file(`${discCacheKey(source.url)}.img`);
  assert.deepEqual(img.bytes(), expected(0, SIZE));
});

// The discio worker's side over a fetcher in this thread. The fake network delivers
// while a demand waits -- one 64 KiB chunk at a time, advancing a clock as a 20 Mbit/s
// link with a 90 ms round trip would, until the demand is answered -- and the rest of
// every response when the test says.
function inThread() {
  const size = 2 * RANGE_BLOCK + RANGE_BLOCK / 2;
  const layout = fetchSharedLayout({ size });
  const buffer = new SharedArrayBuffer(layout.byteLength);
  const ctl = new Int32Array(buffer, 0, layout.ctlInts);
  const listeners = new Set();
  let clock = 0;
  const RTT = 90;
  const BPS = 2.5e6;
  const CHUNK = 64 * K;
  const live = [];
  const requests = [];
  const fetchStream = (url, start, end, signal, onChunk) => new Promise((resolve, reject) => {
    requests.push([start, end]);
    const r = { pos: start, end, signal, onChunk, resolve, first: true };
    signal.addEventListener("abort", () => {
      live.splice(live.indexOf(r), 1);
      reject(new DOMException("aborted", "AbortError"));
    });
    live.push(r);
  });
  const send = (r) => {
    if (r.first) clock += RTT;
    r.first = false;
    const n = Math.min(CHUNK, r.end - r.pos + 1);
    clock += (n / BPS) * 1000;
    r.onChunk(expected(r.pos, r.pos + n));
    r.pos += n;
    if (r.pos > r.end) {
      live.splice(live.indexOf(r), 1);
      r.resolve({ status: 206, etag: null, lastModified: null, total: size });
    }
  };
  const fetcher = new DiscFetcher({
    url: "http://disc/", size, blockSize: RANGE_BLOCK, buffer, layout, fetchStream, now: () => clock,
    notifyReady: () => queueMicrotask(() => { for (const fn of listeners) fn({ data: { type: "ready" } }); })
  });
  const port = {
    postMessage(m) {
      fetcher.handle(m);
      while (m.type === "demand" && (Atomics.load(ctl, 0) & 3) === DEMAND_WAITING && live.length) send(live[0]);
    },
    addEventListener: (type, fn) => listeners.add(fn)
  };
  const client = new FetchWorkerClient({ buffer, layout, port, demandTimeoutMs: 50, waitSliceMs: 5 });
  return {
    size, client, requests, root: new FakeDirectory(), now: () => clock,
    async rest() {
      while (live.length) {
        send(live[0]);
        await settle();
      }
      await settle();
    }
  };
}

test("RangeDisc: a block still arriving stays out of L1 and L2; whole, it comes back into both", async () => {
  const w = inThread();
  const disc = await openRangeDisc({ url: "http://disc/", name: "window.iso", size: w.size }, {
    opfs: true, prefetch: false, getRoot: async () => w.root, estimate: async () => ({ usage: 0, quota: 1e9 }),
    createFetcher: () => w.client, now: w.now, setTimer: () => 0, clearTimer: () => {}
  });
  assert.equal(disc.stats.writer, "discio worker", "this path is the fallback: the discio worker writes the copy");
  const at = RANGE_BLOCK + 1536 * K;                  // 1.5 MiB into block 1
  const got = new Uint8Array(disc.slice(at, at + 128 * K).buffer);
  assert.deepEqual(got, expected(at, at + 128 * K));
  assert.deepEqual(w.requests, [[at, 2 * RANGE_BLOCK - 1]], "the window first, to the end of the block");
  assert.equal(disc.blocks.has(1), false, "not in L1 while it arrives");
  assert.equal(disc.store.has(1), false, "nor in L2");
  assert.equal(disc.stats.waits, 1);

  const again = new Uint8Array(disc.slice(at + 64 * K, at + 128 * K).buffer);
  assert.deepEqual(again, expected(at + 64 * K, at + 128 * K));
  assert.equal(disc.stats.fillingHits, 1, "read again: answered from the slot without waiting");
  const further = new Uint8Array(disc.slice(at + 128 * K, at + 192 * K).buffer);
  assert.deepEqual(further, expected(at + 128 * K, at + 192 * K));
  assert.equal(w.requests.length, 1, "a read further into the block: the same request");
  assert.equal(disc.stats.demand.progressWaits, 1, "it waited on the block's progress");

  await w.rest();                                     // the rest of the block, its start, the block after
  assert.deepEqual(w.requests.slice(0, 2), [[at, 2 * RANGE_BLOCK - 1], [RANGE_BLOCK, at - 1]]);
  assert.equal(disc.blocks.has(1), true, "whole: into L1");
  assert.equal(disc.store.has(1), true, "and L2");
  assert.deepEqual(disc.blocks.get(1), expected(RANGE_BLOCK, 2 * RANGE_BLOCK));
  const files = w.root.dir(DISC_CACHE_DIR);
  const img = files.file(`${discCacheKey("http://disc/")}.img`);
  assert.deepEqual(img.bytes(RANGE_BLOCK, 2 * RANGE_BLOCK), expected(RANGE_BLOCK, 2 * RANGE_BLOCK));
  assert.ok(disc.stats.l1Hits === 0);
  disc.slice(RANGE_BLOCK, RANGE_BLOCK + 10);
  assert.equal(disc.stats.l1Hits, 1);
  await disc.close();
});

test("RangeDisc stats: time to the window and to the whole block, per demand, and the link", async () => {
  const w = inThread();
  const disc = await openRangeDisc({ url: "http://disc/", name: "window.iso", size: w.size }, {
    opfs: false, createFetcher: () => w.client, now: w.now, setTimer: () => 0, clearTimer: () => {}
  });
  const chunk = (64 * K / 2.5e6) * 1000;              // 26.2 ms a 64 KiB chunk at 20 Mbit/s
  const at = 2 * RANGE_BLOCK + 512 * K;               // block 2 (the last, short one), 512 KiB in
  disc.slice(at, at + 128 * K);
  let stats = disc.stats;
  assert.equal(stats.waits, 1);
  assert.equal(stats.demand.waits, 1);
  assert.ok(Math.abs(stats.demand.lastWindowMs - (90 + 2 * chunk)) <= 1, `${stats.demand.lastWindowMs} ms to the window`);
  assert.equal(stats.demand.windowMs, stats.waitMs);
  assert.equal(stats.demand.blocks, 0, "the block is not whole yet");
  assert.equal(stats.demand.windowFirst, 1);
  assert.equal(stats.link.rttMs, Math.round(90 + chunk), "time to the first chunk");
  assert.equal(stats.link.mbit, 0, "not enough seen for a rate yet");

  disc.slice(at + 200 * K, at + 300 * K);             // a little further: waits on the block's progress
  stats = disc.stats;
  assert.equal(stats.waits, 2);
  assert.equal(stats.demand.progressWaits, 1);
  assert.ok(Math.abs(stats.demand.progressMs - 3 * chunk) <= 1, `${stats.demand.progressMs} ms on the block's progress`);
  assert.equal(stats.demand.lastWindowMs, stats.demand.progressMs);
  assert.ok(Math.abs(stats.demand.windowMs - (90 + 5 * chunk)) <= 1);

  await w.rest();
  stats = disc.stats;
  assert.equal(stats.demand.blocks, 1);
  const whole = 90 + ((RANGE_BLOCK / 2 - 512 * K) / 2.5e6) * 1000 + 90 + ((512 * K) / 2.5e6) * 1000;
  assert.ok(Math.abs(stats.demand.lastBlockMs - whole) <= 2, `${stats.demand.lastBlockMs} ms to the whole block, ~${Math.round(whole)} expected`);
  assert.equal(stats.demand.blockMs, stats.demand.lastBlockMs);
  assert.equal(stats.demand.restarts, 0);
  assert.equal(disc.blocks.has(2), true, "?opfs=0: the whole block lands in L1");
  assert.equal(stats.link.mbit, 20, "bytes over the time they took, not counting the wait for the first");
  assert.equal(stats.link.rttMinMs, Math.round(90 + chunk));
  assert.equal(stats.mode, "streaming");
  await disc.close();
});

test("across threads: a window comes back before its block is whole; a later read waits on the same request", async (t) => {
  const size = 4 * 64 * K;
  const blockSize = 64 * K;
  const layout = fetchSharedLayout({ size, blockSize });
  const buffer = new SharedArrayBuffer(layout.byteLength);
  const thread = new Worker(new URL("./helpers/remote-disc-fetcher-thread.mjs", import.meta.url), {
    workerData: { buffer, layout, size, blockSize, chunkDelayMs: 20, chunkSize: 4 * K, windowAlign: 4 * K }
  });
  t.after(() => thread.terminate());
  const listeners = new Set();
  thread.on("message", (data) => { for (const fn of listeners) fn({ data }); });
  const port = { postMessage: (m) => thread.postMessage(m), addEventListener: (type, fn) => listeners.add(fn) };
  await new Promise((resolve) => listeners.add((e) => { if (e.data.type === "hello") resolve(); }));
  const requests = () => new Promise((resolve) => {
    const once = (e) => { if (e.data.type === "requests") { listeners.delete(once); resolve(e.data.requests); } };
    listeners.add(once);
    thread.postMessage({ type: "requests" });
  });
  const discByte = (o) => (o * 7 + (o >>> 5)) & 0xff;
  const client = new FetchWorkerClient({ buffer, layout, port, demandTimeoutMs: 10000 });
  const whole = [];
  client.onReady = () => client.drainReady((block, kind, bytes) => whole.push([block, bytes.slice()]));

  const t0 = performance.now();
  const first = client.demand(2, 40 * K, 4 * K);    // blocks this thread until the window is in
  const ms = performance.now() - t0;
  assert.equal(first.filling, true, "the block was still arriving");
  assert.equal(first.waited, true);
  assert.equal(first.from, 40 * K);
  assert.ok(first.bytes.every((b, i) => b === discByte(2 * blockSize + 40 * K + i)));
  assert.ok(ms < 200, `${Math.round(ms)} ms for the window; the block takes 16 chunks of 20 ms`);

  const second = client.demand(2, 52 * K, 4 * K);
  assert.equal(second.follow, true);
  assert.ok(second.bytes.every((b, i) => b === discByte(2 * blockSize + 52 * K + i)));
  assert.deepEqual(await requests(), [[2 * blockSize + 40 * K, 3 * blockSize - 1]], "one request so far");

  for (let i = 0; i < 100 && !whole.some(([b]) => b === 2); i++) await new Promise((r) => setTimeout(r, 20));
  const [, bytes] = whole.find(([b]) => b === 2);
  assert.ok(bytes.every((b, i) => b === discByte(2 * blockSize + i)), "whole, from two requests");
  assert.deepEqual((await requests()).slice(0, 2), [[2 * blockSize + 40 * K, 3 * blockSize - 1], [2 * blockSize, 2 * blockSize + 40 * K - 1]]);
  await client.close();
});
