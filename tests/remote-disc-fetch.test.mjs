import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { BlockBitmap, KIND_AHEAD, KIND_SEQUENTIAL } from "../src/remote-disc.js";
import {
  DEMAND_DONE,
  DEMAND_FAILED,
  DEMAND_SLOT,
  DEMAND_WAITING,
  DiscFetcher,
  E_HTTP,
  E_NETWORK,
  E_NO_RANGE,
  FetchWorkerClient,
  SEQ_DONE,
  SEQ_PARKED,
  SLOT_FREE,
  SLOT_PARTIAL,
  SLOT_READY,
  demandWord,
  fetchSharedLayout,
  httpFetchStream,
  parseContentRangeTotal
} from "../src/remote-disc-fetch.js";

const SIZE = 100;
const BLOCK = 16;                       // seven blocks, the last four bytes long
const byteAt = (o) => (o * 13 + 7) & 0xff;

function fakeNetwork() {
  const calls = [];
  const fetchStream = (url, start, end, signal, onChunk) => new Promise((resolve, reject) => {
    const call = {
      start,
      end,
      signal,
      sent: 0,
      settled: false,
      push(n = end - start + 1 - call.sent) {
        const bytes = new Uint8Array(n);
        for (let i = 0; i < n; i++) bytes[i] = byteAt(start + call.sent + i);
        call.sent += n;
        onChunk(bytes);
      },
      finish(meta = {}) {
        call.settled = true;
        resolve({ status: 206, etag: null, lastModified: null, total: SIZE, ...meta });
      },
      fail() {
        call.settled = true;
        reject(new TypeError("network error"));
      }
    };
    signal.addEventListener("abort", () => {
      call.settled = true;
      reject(new DOMException("aborted", "AbortError"));
    });
    calls.push(call);
  });
  const live = () => calls.filter((call) => !call.settled);
  const at = (start) => calls.find((call) => call.start === start && !call.settled);
  return { calls, fetchStream, live, at };
}

function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (fn, ms) => { const id = next++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    }
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup({ fetcherOptions = {} } = {}) {
  const layout = fetchSharedLayout({ size: SIZE, blockSize: BLOCK });
  const buffer = new SharedArrayBuffer(layout.byteLength);
  const net = fakeNetwork();
  const clock = fakeClock();
  const ready = [];
  const fetcher = new DiscFetcher({
    url: "http://disc/",
    size: SIZE,
    blockSize: BLOCK,
    buffer,
    layout,
    fetchStream: net.fetchStream,
    notifyReady: () => ready.push(true),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...fetcherOptions
  });
  const ctl = new Int32Array(buffer, 0, layout.ctlInts);
  const bitmap = new BlockBitmap(layout.blocks, new Uint8Array(buffer, layout.bitmapOffset, layout.bitmapBytes));
  const counters = new Float64Array(buffer, layout.countersOffset, 8);
  const slot = (s) => ({
    state: Atomics.load(ctl, 8 + s * 4),
    block: Atomics.load(ctl, 8 + s * 4 + 1),
    got: Atomics.load(ctl, 8 + s * 4 + 2),
    kind: Atomics.load(ctl, 8 + s * 4 + 3)
  });
  const slotBytes = (s, n) => new Uint8Array(buffer, layout.dataOffset + s * BLOCK, n).slice();
  let seq = 0;
  const demand = (block) => {
    seq += 1;
    Atomics.store(ctl, 0, demandWord(seq, DEMAND_WAITING));
    fetcher.handle({ type: "demand", block, seq });
    return seq;
  };
  const demandState = () => Atomics.load(ctl, 0) & 3;
  // What the discio worker does with a finished background slot.
  const consume = (s) => {
    bitmap.set(slot(s).block);
    Atomics.store(ctl, 8 + s * 4, SLOT_FREE);
    fetcher.handle({ type: "freed" });
  };
  return { fetcher, net, clock, ctl, bitmap, counters, slot, slotBytes, demand, demandState, consume, ready, layout };
}

function expected(start, end) {
  const out = new Uint8Array(end - start);
  for (let i = 0; i < out.length; i++) out[i] = byteAt(start + i);
  return out;
}

test("a miss parks the sequential stream, goes alone, then the block ahead and the stream resume", async () => {
  const t = setup();
  t.fetcher.handle({ type: "sequential", on: true, cap: 0 });
  assert.deepEqual(t.net.live().map((c) => [c.start, c.end]), [[0, 15], [16, 31]], "two in flight, in order");
  t.net.at(0).push(5);
  t.net.at(16).push(9);
  const block0 = t.net.at(0);
  const block1 = t.net.at(16);

  t.demand(4);
  assert.equal(block0.signal.aborted, true, "parked: aborted from this thread, so it frees the link now");
  assert.equal(block1.signal.aborted, true);
  assert.deepEqual(t.net.live().map((c) => [c.start, c.end]), [[64, 79]], "the miss is the only request");
  assert.deepEqual([t.slot(1).state, t.slot(1).got], [SLOT_PARTIAL, 5], "each keeps what it got");
  assert.deepEqual([t.slot(2).state, t.slot(2).got], [SLOT_PARTIAL, 9]);
  assert.equal(Atomics.load(t.ctl, 5), SEQ_PARKED);

  t.fetcher.handle({ type: "freed" });
  t.clock.advance(5000);
  assert.equal(t.net.live().length, 1, "nothing starts while the miss is outstanding");

  t.net.at(64).push();
  t.net.at(64).finish();
  await settle();
  assert.equal(t.demandState(), DEMAND_DONE);
  assert.equal(Atomics.load(t.ctl, 1), DEMAND_SLOT);
  assert.deepEqual(t.slotBytes(DEMAND_SLOT, 16), expected(64, 80));

  assert.deepEqual(t.net.live().map((c) => [c.start, c.end]), [[80, 95], [5, 15]],
    "first one block ahead of the miss, then the stream from where block 0 stopped");
  assert.equal(t.counters[2], 5, "five bytes salvaged");
  t.net.at(5).push();
  t.net.at(5).finish();
  await settle();
  assert.equal(t.slot(1).state, SLOT_READY);
  assert.deepEqual(t.slotBytes(1, 16), expected(0, 16), "the resumed block is whole");
});

test("never more than two requests in flight, and none beside an outstanding miss", async () => {
  const t = setup();
  const check = () => {
    const waiting = t.demandState() === DEMAND_WAITING;
    assert.ok(t.net.live().length <= (waiting ? 1 : 2), `${t.net.live().length} in flight`);
  };
  t.fetcher.handle({ type: "sequential", on: true, cap: 0 });
  check();
  t.fetcher.handle({ type: "ahead", block: 5 });
  check();
  t.fetcher.handle({ type: "ahead", block: 6 });
  check();
  t.demand(3);
  check();
  t.fetcher.handle({ type: "ahead", block: 2 });
  check();
  t.net.at(48).push();
  t.net.at(48).finish();
  await settle();
  check();
  for (let round = 0; round < 12; round++) {
    for (const call of t.net.live()) {
      call.push();
      call.finish();
    }
    await settle();
    for (let s = 1; s < t.layout.slots; s++) if (t.slot(s).state === SLOT_READY) t.consume(s);
    check();
  }
});

test("a miss on a block already on its way continues that request", async () => {
  const t = setup();
  t.fetcher.handle({ type: "sequential", on: true, cap: 0 });
  t.net.at(16).push(8);
  const before = t.net.calls.length;
  t.demand(1);
  assert.equal(t.net.calls.length, before, "no second request for the block");
  assert.equal(t.net.calls[0].signal.aborted, true, "block 0 steps aside");
  assert.equal(t.net.at(16).signal.aborted, false);
  t.net.at(16).push();
  t.net.at(16).finish();
  await settle();
  assert.equal(t.demandState(), DEMAND_DONE);
  const s = Atomics.load(t.ctl, 1);
  assert.notEqual(s, DEMAND_SLOT, "answered from the slot it was filling");
  assert.deepEqual(t.slotBytes(s, 16), expected(16, 32));
});

test("a miss on a finished block is answered without a request", async () => {
  const t = setup();
  t.fetcher.handle({ type: "sequential", on: true, cap: 0 });
  t.net.at(0).push();
  t.net.at(0).finish();
  await settle();
  assert.equal(t.ready.length, 1, "the discio worker is nudged");
  const before = t.net.calls.length;
  const live = t.net.live();
  t.demand(0);
  assert.equal(t.demandState(), DEMAND_DONE);
  assert.equal(t.net.calls.length, before, "no request: block 1, the one ahead, is already on its way");
  assert.ok(live.every((call) => !call.signal.aborted), "and nothing was parked for it");
});

test("the sequential stream goes in order, skips blocks already here, and reports done", async () => {
  const t = setup();
  t.bitmap.set(0);
  t.bitmap.set(2);
  t.fetcher.handle({ type: "sequential", on: true, cap: 0 });
  assert.deepEqual(t.net.live().map((c) => c.start), [16, 48]);
  for (let round = 0; round < 6 && t.bitmap.present < t.bitmap.count; round++) {
    for (const call of t.net.live()) {
      call.push();
      call.finish();
    }
    await settle();
    for (let s = 1; s < t.layout.slots; s++) if (t.slot(s).state === SLOT_READY) t.consume(s);
  }
  assert.equal(t.bitmap.complete, true);
  assert.deepEqual(t.net.calls.map((c) => c.start), [16, 48, 64, 80, 96]);
  assert.equal(t.net.calls.at(-1).end, 99, "the last block is short");
  assert.equal(Atomics.load(t.ctl, 5), SEQ_DONE);
});

test("the cap paces sequential starts; misses and blocks ahead are not held to it", () => {
  const t = setup();
  t.fetcher.handle({ type: "sequential", on: true, cap: BLOCK });   // one block a second
  assert.deepEqual(t.net.live().map((c) => c.start), [0]);
  t.clock.advance(999);
  assert.equal(t.net.live().length, 1);
  t.clock.advance(1);
  assert.deepEqual(t.net.live().map((c) => c.start), [0, 16]);
  t.fetcher.handle({ type: "ahead", block: 5 });
  assert.deepEqual(t.net.live().map((c) => c.start), [0, 80], "the ahead block bumps the furthest stream request");
  t.demand(6);
  assert.deepEqual(t.net.live().map((c) => c.start), [96]);
});

test("a miss retries a network error, then fails with a code the discio worker can name", async () => {
  const t = setup();
  t.demand(2);
  t.net.at(32).push(3);
  t.net.at(32).fail();
  await settle();
  assert.equal(t.net.live().length, 0);
  assert.equal(t.demandState(), DEMAND_WAITING, "still waiting through the backoff");
  t.clock.advance(250);
  assert.deepEqual(t.net.live().map((c) => [c.start, c.end]), [[35, 47]], "the retry resumes after the bytes it had");
  for (let i = 0; i < 3; i++) {
    t.net.live()[0].fail();
    await settle();
    t.clock.advance(10000);
  }
  assert.equal(t.demandState(), DEMAND_FAILED);
  assert.equal(Atomics.load(t.ctl, 2), E_NETWORK);

  for (const [status, code] of [[404, E_HTTP], [200, E_NO_RANGE]]) {
    const u = setup();
    u.demand(1);
    u.net.at(16).finish({ status });
    await settle();
    assert.equal(u.demandState(), DEMAND_FAILED, `HTTP ${status} is not retried`);
    assert.equal(Atomics.load(u.ctl, 2), code);
    assert.equal(Atomics.load(u.ctl, 3), status);
  }
});

test("a disc that changed on the server stops the stream but still answers the miss", async () => {
  const t = setup();
  t.fetcher.handle({ type: "sequential", on: true, cap: 0 });
  t.net.at(0).push();
  t.net.at(0).finish({ total: 999 });
  await settle();
  assert.equal(Atomics.load(t.ctl, 4) & 1, 1, "flagged");
  assert.equal(t.slot(1).state, SLOT_FREE, "the background block is dropped");
  assert.equal(t.net.calls[1].signal.aborted, true, "the stream stops");
  t.demand(3);
  t.net.at(48).push();
  t.net.at(48).finish({ etag: "\"other\"" });
  await settle();
  assert.equal(t.demandState(), DEMAND_DONE);
});

test("a block ahead steps in front of the furthest sequential request", () => {
  const t = setup();
  t.fetcher.handle({ type: "sequential", on: true, cap: 0 });
  t.net.at(16).push(4);
  t.fetcher.handle({ type: "ahead", block: 5 });
  assert.equal(t.net.calls[1].signal.aborted, true);
  assert.deepEqual(t.net.live().map((c) => c.start), [0, 80]);
  assert.equal(t.slot(2).state, SLOT_PARTIAL, "the stream keeps what it had");
  t.fetcher.handle({ type: "ahead", block: 5 });
  assert.equal(t.net.calls.length, 3, "asked twice, fetched once");
});

test("across threads: a miss blocks on the shared word and comes back with its bytes", async (t) => {
  const size = 1000;
  const blockSize = 256;
  const layout = fetchSharedLayout({ size, blockSize });
  const buffer = new SharedArrayBuffer(layout.byteLength);
  const thread = new Worker(new URL("./helpers/remote-disc-fetcher-thread.mjs", import.meta.url), {
    workerData: { buffer, layout, size, blockSize, chunkDelayMs: 2 }
  });
  t.after(() => thread.terminate());
  const listeners = new Set();
  thread.on("message", (data) => { for (const fn of listeners) fn({ data }); });
  const port = { postMessage: (m) => thread.postMessage(m), addEventListener: (type, fn) => listeners.add(fn) };
  await new Promise((resolve) => listeners.add((e) => { if (e.data.type === "hello") resolve(); }));

  const client = new FetchWorkerClient({ buffer, layout, port, demandTimeoutMs: 10000 });
  const discByte = (o) => (o * 7 + (o >>> 5)) & 0xff;
  const bitmap = new BlockBitmap(layout.blocks, client.bitmapBytes);
  const have = new Map();
  client.onReady = () => client.drainReady((block, kind, bytes) => {
    assert.ok(kind === KIND_SEQUENTIAL || kind === KIND_AHEAD);
    have.set(block, bytes.slice());
    bitmap.set(block);
  });

  client.setSequential(true, 0);
  const { bytes, waited } = client.demand(3);       // blocks this thread until the fetcher answers
  assert.equal(waited, true);
  assert.equal(bytes.length, size - 3 * blockSize);
  assert.ok(bytes.every((b, i) => b === discByte(768 + i)));
  have.set(3, bytes);
  bitmap.set(3);

  for (let i = 0; i < 200 && bitmap.present < bitmap.count; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(bitmap.complete, true, "the sequential stream resumed and finished the disc");
  for (const [block, data] of have) {
    assert.ok(data.every((b, i) => b === discByte(block * blockSize + i)), `block ${block}`);
  }
  assert.equal(client.sequentialState(), "done");
  assert.ok(client.counters().bytes >= size);
  client.close();
});

test("httpFetchStream: Range, validators and total; an abort keeps what came; a 200 is not read", async (t) => {
  const data = new Uint8Array(4096).map((_, i) => i & 0xff);
  const server = createServer(async (req, res) => {
    if (req.url === "/ignore") {
      res.writeHead(200, { "Content-Length": data.length });
      res.end(data);
      return;
    }
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(req.headers.range);
    const slice = data.subarray(Number(a), Number(b) + 1);
    res.writeHead(206, {
      "Content-Range": `bytes ${a}-${b}/${data.length}`,
      "Content-Length": slice.length,
      ETag: "\"abc\"",
      "Last-Modified": "Thu, 01 Oct 2026 00:00:00 GMT"
    });
    for (let i = 0; i < slice.length; i += 512) {
      res.write(slice.subarray(i, i + 512));
      await new Promise((r) => setTimeout(r, req.url === "/slow" ? 30 : 0));
    }
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const got = [];
  const meta = await httpFetchStream(`${base}/disc`, 100, 2099, new AbortController().signal, (chunk) => got.push(chunk));
  assert.deepEqual(meta, { status: 206, etag: "\"abc\"", lastModified: "Thu, 01 Oct 2026 00:00:00 GMT", total: 4096 });
  const joined = Buffer.concat(got);
  assert.equal(joined.length, 2000);
  assert.equal(joined[0], 100);

  const ctrl = new AbortController();
  let seen = 0;
  const aborted = httpFetchStream(`${base}/slow`, 0, 4095, ctrl.signal, (chunk) => {
    seen += chunk.length;
    if (seen >= 512) ctrl.abort();
  });
  await assert.rejects(aborted, { name: "AbortError" });
  assert.ok(seen >= 512 && seen < 4096);

  let read = 0;
  const ignored = await httpFetchStream(`${base}/ignore`, 0, 15, new AbortController().signal, () => { read++; });
  assert.equal(ignored.status, 200);
  assert.equal(read, 0, "the whole image is never read for a block");

  assert.equal(parseContentRangeTotal("bytes 0-15/4096"), 4096);
  assert.equal(parseContentRangeTotal("bytes 0-15/*"), null);
  assert.equal(parseContentRangeTotal(null), null);
});
