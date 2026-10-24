// L3 for a remote disc: every HTTP request goes through a fetch worker of its own.
//
// Why a second worker: a read the core is waiting on has to be answered synchronously
// (WORKERFS is synchronous), so the discio worker blocks until the bytes arrive. A
// fetch in the discio worker can't be aborted while it blocks -- the cancellation only
// reaches the network once its event loop turns, which measured the same as not
// aborting at all (a 4 MiB miss beside two streaming requests: 1.09 s aborted vs 1.11 s
// not, 0.43 s alone, on a shared 100 Mbit link). A fetch worker's loop stays free, so a
// miss can park the sequential stream at once and have the link to itself.
//
// The two workers share one SharedArrayBuffer (fetchSharedLayout):
//   - a control block: the demand word (sequence << 2 | state), its answer, flags, and
//     a small table of slots (state, block, bytes so far, kind);
//   - counters (bytes received, requests, bytes salvaged from parked requests, aborts,
//     what demands waited for, and an estimate of the link);
//   - the L2 bitmap, which only the discio worker writes and the fetcher reads to know
//     what it need not fetch;
//   - the slots' data, one block each. Slot 0 is where a demand starts; the others hold
//     the at most two requests in flight and finished blocks the discio worker hasn't
//     taken.
//
// A miss: the discio worker takes the block from a finished slot if one has it, else
// posts {demand, block, from, len} -- the part of the core's read that falls in this
// block, its window -- and waits on the demand word. The fetcher aborts every other
// request (each keeps what it got; a later request resumes from there), continues the
// block if it was already on its way or starts it, and answers as soon as the slot holds
// the window, not the whole block: the discio worker copies those bytes and the core goes
// on. A window well into the block is fetched first (from its start, aligned down to
// 64 KiB, to the end of the block), then the start of the block. The block keeps the link
// to itself until it is whole, and a later read into it waits on that same slot. Whole,
// it is offered to the discio worker (into L1, as a miss's block always was) and written
// to L2; then the fetcher resumes: one block ahead of the miss first, then the
// sequential stream.
//
// A block can therefore fill out of order, so each slot keeps the ranges that have
// arrived, not a high-water mark: a parked block resumes from its gaps, whichever order
// they came in. L1 and L2 only ever get whole blocks.
//
// Where shared sync handles exist (SHARED_SYNC_MODE), the fetcher also writes this
// device's copy: every block it fetches goes to OPFS from here, flushes and the bitmap
// file too, and the discio worker only reads. Writing a 4 MiB block into the sparse
// image measured 24 ms on this project's CI-class disk (block allocation) and a flush
// after 5 s of writes 55 ms -- time the discio worker, which serves the core's reads
// and presents frames, should not spend. Elsewhere the discio worker owns the copy and
// takes finished blocks from the slots, as below.

import {
  BlockBitmap,
  KIND_AHEAD,
  KIND_DEMAND,
  KIND_SEQUENTIAL,
  MAX_IN_FLIGHT,
  OpfsDiscStore,
  RANGE_BLOCK,
  blockCount,
  blockLength,
  discCacheKey
} from "./remote-disc.js";

export const SLOT_FREE = 0;
export const SLOT_FILLING = 1;
export const SLOT_READY = 2;
export const SLOT_PARTIAL = 3;

export const DEMAND_IDLE = 0;
export const DEMAND_WAITING = 1;
export const DEMAND_DONE = 2;
export const DEMAND_FAILED = 3;

// What an answer is (H_DEMAND_INFO): only the window (the block is still arriving), the
// fetcher had to wait on the network for it, the read was into the block a read before it
// was already waiting on (so it waited on that block's progress).
export const INFO_WINDOW = 1;
export const INFO_WAITED = 2;
export const INFO_FOLLOW = 4;

export const SEQ_OFF = 0;
export const SEQ_RUNNING = 1;
export const SEQ_PARKED = 2;
export const SEQ_PAUSED = 3;
export const SEQ_DONE = 4;
const SEQ_NAMES = ["off", "running", "parked", "paused", "done"];

export const E_HTTP = 1;
export const E_NO_RANGE = 2;
export const E_SHORT = 3;
export const E_NETWORK = 4;
export const E_CHANGED = 5;

export const DEMAND_SLOT = 0;
export const DEFAULT_SLOTS = 1 + MAX_IN_FLIGHT + 2;

// A window is fetched from its start aligned down to this; one in the block's first
// 64 KiB is fetched from the start of the block.
export const WINDOW_ALIGN = 64 * 1024;
// A later read into the block being fetched for a read waits on that request when its
// window is at most this far ahead of it (or a round trip's worth of bytes, if more);
// further, the request restarts at the new window and the skipped part comes after.
export const RESTART_MIN = 256 * 1024;

const H_DEMAND = 0;
const H_DEMAND_SLOT = 1;
const H_DEMAND_ERROR = 2;
const H_DEMAND_DETAIL = 3;
const H_FLAGS = 4;
const H_SEQ_STATE = 5;
const H_DEMAND_INFO = 6;
const HEADER_INTS = 8;
const SLOT_INTS = 4;
const S_STATE = 0;
const S_BLOCK = 1;
const S_GOT = 2;
const S_KIND = 3;
const FLAG_CHANGED = 1;
const FLAG_STORE_LOST = 2;
const FLAG_STORE_COMPLETE = 4;
const C_BYTES = 0;
const C_REQUESTS = 1;
const C_SALVAGED = 2;
const C_ABORTS = 3;
const C_DEMANDS = 4;
const C_WRITE_MS = 5;
const C_PERSIST_MS = 6;
const C_RESTARTS = 7;          // requests restarted at a later read's window
const C_WINDOW_FIRST = 8;      // requests that began at a window, ahead of a missing start
const C_BLOCKS = 9;            // blocks a read waited on, once whole
const C_BLOCK_MS = 10;         // ... from its first demand to the whole block: total
const C_BLOCK_LAST_MS = 11;    // ... and the last one
const C_LINK_BPS = 12;         // bytes per second while a response is arriving
const C_RTT_MS = 13;           // time to a response's first bytes (smoothed)
const C_RTT_MIN_MS = 14;       // ... and the shortest seen
const COUNTERS = 16;
const PERSIST_INTERVAL_MS = 5000;
const META_INTERVAL_MS = 15000;
// The link estimate forgets with this time constant (of time spent receiving), and says
// nothing until it has seen this much.
const LINK_TAU_MS = 3000;
const LINK_MIN_MS = 200;

export function demandWord(seq, state) {
  return ((seq & 0x1fffffff) << 2) | state;
}

export function fetchSharedLayout({ size, blockSize = RANGE_BLOCK, slots = DEFAULT_SLOTS }) {
  const blocks = blockCount(size, blockSize);
  const ctlInts = HEADER_INTS + slots * SLOT_INTS;
  const countersOffset = Math.ceil((ctlInts * 4) / 8) * 8;
  const bitmapOffset = countersOffset + COUNTERS * 8;
  const bitmapBytes = Math.ceil(blocks / 8);
  const dataOffset = Math.ceil((bitmapOffset + bitmapBytes) / 8) * 8;
  return {
    size, blockSize, blocks, slots, ctlInts, countersOffset, bitmapOffset, bitmapBytes, dataOffset,
    byteLength: dataOffset + slots * blockSize
  };
}

function sharedViews(buffer, layout) {
  const slots = [];
  for (let s = 0; s < layout.slots; s++) {
    slots.push(new Uint8Array(buffer, layout.dataOffset + s * layout.blockSize, layout.blockSize));
  }
  return {
    ctl: new Int32Array(buffer, 0, layout.ctlInts),
    counters: new Float64Array(buffer, layout.countersOffset, COUNTERS),
    bitmap: new Uint8Array(buffer, layout.bitmapOffset, layout.bitmapBytes),
    slots
  };
}

const slotField = (s, field) => HEADER_INTS + s * SLOT_INTS + field;

export function describeFetchError(code, detail, block) {
  const where = `disc block ${block}`;
  if (code === E_HTTP) return `${where}: HTTP ${detail}`;
  if (code === E_NO_RANGE) return `${where}: the server ignored the Range request`;
  if (code === E_SHORT) return `${where}: short read (${detail} bytes)`;
  if (code === E_CHANGED) return `${where}: the disc changed on the server`;
  return `${where}: network error`;
}

function retryable({ code, detail }) {
  if (code === E_NETWORK || code === E_SHORT) return true;
  return code === E_HTTP && (detail >= 500 || detail === 408 || detail === 429);
}

export function parseContentRangeTotal(header) {
  const match = /\/(\d+)\s*$/.exec(header ?? "");
  return match ? Number(match[1]) : null;
}

// ── what part of a block a slot holds ──
// Sorted, disjoint [start, end) pairs, block-relative. Adjacent or overlapping ranges
// merge, so a window covered at all is covered by one range.

export function addRange(ranges, start, end) {
  if (!(end > start)) return ranges;
  let i = 0;
  while (i < ranges.length && ranges[i][1] < start) i++;
  let j = i;
  while (j < ranges.length && ranges[j][0] <= end) {
    start = Math.min(start, ranges[j][0]);
    end = Math.max(end, ranges[j][1]);
    j++;
  }
  ranges.splice(i, j - i, [start, end]);
  return ranges;
}

export function rangeBytes(ranges) {
  let n = 0;
  for (const [a, b] of ranges) n += b - a;
  return n;
}

/** The first offset in [start, end) that has not arrived, or -1 when all of it has. */
export function firstMissing(ranges, start, end) {
  let at = start;
  for (const [a, b] of ranges) {
    if (b <= at) continue;
    if (a > at) break;
    at = b;
  }
  return at < end ? at : -1;
}

/**
 * The next range to request for a block of `len` bytes: the gap holding (or after) the
 * first missing byte at or after `prefer`, from that byte aligned down to `align`; with
 * nothing missing after it, or no `prefer`, the first gap. Null when the block is whole.
 */
export function nextRange(ranges, len, prefer = null, align = WINDOW_ALIGN) {
  let at = prefer == null ? -1 : firstMissing(ranges, Math.min(prefer, len), len);
  const fromWindow = at >= 0;
  if (!fromWindow) at = firstMissing(ranges, 0, len);
  if (at < 0) return null;
  let gapStart = 0;
  let gapEnd = len;
  for (const [a, b] of ranges) {
    if (b <= at) gapStart = b;
    else if (a > at) {
      gapEnd = a;
      break;
    }
  }
  return [fromWindow ? Math.max(gapStart, at - (at % align)) : at, gapEnd];
}

// One Range request, its body handed over chunk by chunk as it arrives (so an abort
// keeps what came, and a read can be answered before the end). A response that isn't
// 206 is not read: with the Range ignored it would be the whole image.
export async function httpFetchStream(url, start, end, signal, onChunk, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url, {
    headers: { Range: `bytes=${start}-${end}` },
    credentials: "same-origin",
    cache: "no-store",
    signal
  });
  const meta = {
    status: response.status,
    etag: response.headers.get("ETag"),
    lastModified: response.headers.get("Last-Modified"),
    total: parseContentRangeTotal(response.headers.get("Content-Range"))
  };
  if (response.status !== 206 || !response.body) {
    try { await response.body?.cancel(); } catch { /* nothing to drain */ }
    return meta;
  }
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk(value);
  }
  return meta;
}

// The scheduler, in the fetch worker. Everything it is told arrives as a message; all
// it tells the discio worker goes through the shared buffer (plus a "ready" nudge).
//
// Each slot has at most one request; a request fetches one range of its slot's block.
// `urgent` is the block a read is waiting on, or was answered from and is still
// arriving: while there is one, nothing else is fetched (the stream is parked).
export class DiscFetcher {
  constructor({
    url,
    size,
    blockSize = RANGE_BLOCK,
    buffer,
    layout,
    validators = {},
    fetchStream = httpFetchStream,
    notifyReady = () => {},
    post = () => {},
    store = null,
    now = () => performance.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    maxInFlight = MAX_IN_FLIGHT,
    demandRetries = 3,
    retryBaseMs = 250,
    windowAlign = WINDOW_ALIGN,
    restartMin = RESTART_MIN
  }) {
    this.url = url;
    this.size = size;
    this.blockSize = blockSize;
    this.blocks = blockCount(size, blockSize);
    this.layout = layout;
    const views = sharedViews(buffer, layout);
    this.ctl = views.ctl;
    this.counters = views.counters;
    this.bitmap = views.bitmap;
    this.slotData = views.slots;
    this.filled = Array.from({ length: layout.slots }, () => []);   // per slot: the ranges that have arrived
    this.tainted = new Uint8Array(layout.slots);                    // a response said the disc changed: not for the copy
    this.etag = validators.etag ? String(validators.etag).replace(/^W\//, "") : null;
    this.lastModified = validators.lastModified ?? null;
    this.fetchStream = fetchStream;
    this.notifyReady = notifyReady;
    this.post = post;
    this.store = store;
    this.persistTimer = null;
    this.lastMetaAt = 0;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.maxInFlight = maxInFlight;
    this.demandRetries = demandRetries;
    this.retryBaseMs = retryBaseMs;
    this.windowAlign = windowAlign;
    this.restartMin = restartMin;
    this.inflight = new Map();          // slot -> request
    this.demandReq = null;              // the read the discio worker is blocked on
    this.urgent = null;                 // { block, from, since, retries }: the block a read needs, until whole
    this.aheadQueue = [];
    this.sequential = false;
    this.cap = 0;
    this.nextSequentialAt = 0;
    this.cursor = 0;
    this.order = [];                    // a read order (remote-disc.js): blocks the sequential stream takes first
    this.orderAt = 0;
    this.failures = 0;
    this.pausedUntil = 0;
    this.timer = null;
    this.timerAt = Infinity;
    this.stopped = false;
    this.receiving = 0;                 // requests past their first bytes, not ended
    this.linkAt = null;
    this.linkBytes = 0;
    this.linkMs = 0;
    this.rtt = 0;
    this.rttMin = 0;
  }

  get parked() {
    return this.urgent !== null;
  }

  handle(message) {
    switch (message?.type) {
      case "demand":
        return this.demand(message.block, message.seq, message.from, message.len);
      case "ahead":
        return this.ahead(message.block);
      case "sequential":
        this.sequential = Boolean(message.on);
        this.cap = Math.max(0, Number(message.cap) || 0);
        this.nextSequentialAt = 0;
        this.cursor = 0;
        this.orderAt = 0;
        if (!this.sequential) {
          for (const req of [...this.inflight.values()]) if (req.kind === KIND_SEQUENTIAL) this.abort(req);
        }
        return this.pump();
      case "order":
        this.order = (message.blocks ?? []).filter((b) => Number.isInteger(b) && b >= 0 && b < this.blocks);
        this.orderAt = 0;
        return this.pump();
      case "freed":
        return this.pump();
      case "dropStore":
        return this.dropStore(message);
      case "flush":
        return this.persist({ meta: true });
      case "stop":
        return this.stop();
      default:
        return undefined;
    }
  }

  // ── this device's copy, when this worker writes it ──
  writeToStore(block, s) {
    const store = this.store;
    if (!store || store.has(block)) return;
    const t0 = this.now();
    try {
      store.write(block, this.slotData[s].subarray(0, blockLength(block, this.size, this.blockSize)));
    } catch (error) {
      this.loseStore(`writing to this device failed (${error?.message || error})`);
      return;
    } finally {
      this.counters[C_WRITE_MS] += this.now() - t0;
    }
    if (store.complete) {
      this.persist({ meta: true });
      Atomics.or(this.ctl, H_FLAGS, FLAG_STORE_COMPLETE);
    } else if (this.persistTimer == null) {
      this.persistTimer = this.setTimer(() => {
        this.persistTimer = null;
        this.persist();
      }, PERSIST_INTERVAL_MS);
    }
  }

  persist({ meta = false } = {}) {
    const store = this.store;
    if (!store) return;
    const t0 = this.now();
    try {
      store.persist();
    } catch (error) {
      this.loseStore(`saving progress on this device failed (${error?.message || error})`);
      return;
    } finally {
      this.counters[C_PERSIST_MS] += this.now() - t0;
    }
    if (meta || this.now() - this.lastMetaAt >= META_INTERVAL_MS) {
      this.lastMetaAt = this.now();
      store.writeMeta().catch(() => {});
    }
  }

  // The copy can't be written any more: the discio worker is told (flag + reason) and
  // stops reading it; the bitmap is cleared so nothing is skipped that isn't anywhere.
  loseStore(reason) {
    const store = this.store;
    if (!store) return;
    this.store = null;
    if (this.persistTimer != null) this.clearTimer(this.persistTimer);
    this.persistTimer = null;
    this.sequential = false;
    store.close().catch(() => {}).finally(() => store.release?.());
    store.bitmap.clear();
    this.post({ type: "storeLost", reason });
    Atomics.or(this.ctl, H_FLAGS, FLAG_STORE_LOST);
  }

  async dropStore({ remove = false } = {}) {
    const store = this.store;
    this.store = null;
    if (this.persistTimer != null) this.clearTimer(this.persistTimer);
    this.persistTimer = null;
    this.sequential = false;
    for (const req of [...this.inflight.values()]) if (req.kind === KIND_SEQUENTIAL) this.abort(req);
    if (store) {
      try {
        await (remove ? store.remove() : store.close());
      } catch { /* closing is best effort; removal errors are reported by the page */ }
      store.bitmap.clear();
      store.release?.();
    }
    this.post({ type: "storeDropped" });
    this.pump();
  }

  slotGet(s, field) {
    return Atomics.load(this.ctl, slotField(s, field));
  }

  slotSet(s, state, block, got, kind) {
    Atomics.store(this.ctl, slotField(s, S_BLOCK), block);
    Atomics.store(this.ctl, slotField(s, S_GOT), got);
    Atomics.store(this.ctl, slotField(s, S_KIND), kind);
    Atomics.store(this.ctl, slotField(s, S_STATE), state);
  }

  findSlot(block, state) {
    for (let s = 0; s < this.layout.slots; s++) {
      if (this.slotGet(s, S_STATE) === state && this.slotGet(s, S_BLOCK) === block) return s;
    }
    return -1;
  }

  // The slot with part of this block in it: arriving, else parked.
  slotOf(block) {
    const filling = this.findSlot(block, SLOT_FILLING);
    return filling >= 0 ? filling : this.findSlot(block, SLOT_PARTIAL);
  }

  // The slot the discio worker is copying a window out of: answered, not yet taken.
  pinned(s) {
    return (Atomics.load(this.ctl, H_DEMAND) & 3) === DEMAND_DONE && Atomics.load(this.ctl, H_DEMAND_SLOT) === s;
  }

  present(block) {
    return (Atomics.load(this.bitmap, block >> 3) & (1 << (block & 7))) !== 0;
  }

  busy(block) {
    return this.findSlot(block, SLOT_FILLING) >= 0 || this.findSlot(block, SLOT_READY) >= 0;
  }

  covered(s, d) {
    return firstMissing(this.filled[s], d.from, d.end) < 0;
  }

  // ── a read the core is waiting on ──
  demand(block, seq, from = 0, len = null) {
    if (this.stopped) return undefined;
    this.counters[C_DEMANDS] += 1;
    const size = blockLength(block, this.size, this.blockSize);
    const start = Math.max(0, Math.min(Number(from) || 0, size - 1));
    const end = len == null ? size : Math.max(start + 1, Math.min(size, start + Number(len)));
    const d = { seq, block, from: start, end, follow: this.urgent?.block === block };
    this.demandReq = d;
    const ready = this.findSlot(block, SLOT_READY);
    if (ready >= 0) {
      this.answer(ready, false);
      this.ahead(block + 1, { first: true });   // one block ahead of the miss, before the stream resumes
      return this.pump();
    }
    // A miss outranks everything: every other request stops now, keeping what it got.
    for (const req of [...this.inflight.values()]) if (req.block !== block) this.abort(req);
    if (!d.follow) this.urgent = { block, from: start, since: this.now(), retries: 0 };
    this.urgent.from = start;
    this.updateSequentialState();
    let s = this.slotOf(block);
    const req = s >= 0 ? this.inflight.get(s) : null;
    if (req) {
      req.kind = KIND_DEMAND;
      Atomics.store(this.ctl, slotField(s, S_KIND), KIND_DEMAND);
    }
    if (s >= 0 && this.covered(s, d)) {
      this.answer(s, false);
      if (!req) this.start(s, block, KIND_DEMAND);   // the rest of a parked block, at demand priority
      return undefined;
    }
    if (req) {
      if (!this.coming(req, d)) this.restart(req);
      return undefined;                          // answered from that request's progress
    }
    if (s < 0) s = this.demandSlotFor();
    if (s < 0) return this.failDemand({ code: E_NETWORK, detail: 0 });
    this.start(s, block, KIND_DEMAND);
    return undefined;
  }

  // Will the request in flight bring the window soon? Only if the window's first missing
  // byte lies ahead of the request within its range, and not far ahead. (A window that
  // runs on past the range into another gap gets the rest from the next request, which
  // starts at the window's next missing byte.)
  coming(req, d) {
    const miss = firstMissing(this.filled[req.slot], d.from, d.end);
    if (miss < 0) return true;
    if (miss < req.pos || miss >= req.end) return false;
    return miss - req.pos <= Math.max(this.restartMin, (this.counters[C_LINK_BPS] * this.rtt) / 1000);
  }

  // The request stops where it is (its bytes stay in the slot) and a new one starts at
  // the window the read is waiting on; what it skipped comes after.
  restart(req) {
    this.counters[C_RESTARTS] += 1;
    this.stopRequest(req);
    return this.request(req.slot, req.block, KIND_DEMAND);
  }

  // A slot for a block a read needs: a free one (slot 0 first), else one holding part of
  // another block, else -- only while the discio worker is blocked on this read, so it
  // is reading no slot -- a finished block it hasn't taken yet (a sequential one first).
  demandSlotFor() {
    let best = -1;
    let rank = Infinity;
    for (let s = 0; s < this.layout.slots; s++) {
      if (this.inflight.has(s) || this.pinned(s)) continue;
      const state = this.slotGet(s, S_STATE);
      let r = Infinity;
      if (state === SLOT_FREE) r = s === DEMAND_SLOT ? 0 : 1;
      else if (state === SLOT_PARTIAL) r = 2;
      else if (state === SLOT_READY && this.demandReq) r = this.slotGet(s, S_KIND) === KIND_SEQUENTIAL ? 3 : 4;
      if (r < rank) {
        best = s;
        rank = r;
      }
    }
    if (best >= 0 && rank > 1) this.slotSet(best, SLOT_FREE, 0, 0, 0);
    return best;
  }

  ahead(block, { first = false } = {}) {
    if (this.stopped || !(block >= 0 && block < this.blocks)) return;
    if (this.present(block) || this.busy(block)) return;
    const queued = this.aheadQueue.indexOf(block);
    if (queued >= 0) this.aheadQueue.splice(queued, 1);
    if (first) this.aheadQueue.unshift(block);
    else this.aheadQueue.push(block);
    if (this.aheadQueue.length > this.maxInFlight) {
      if (first) this.aheadQueue.pop();
      else this.aheadQueue.shift();
    }
    this.pump();
  }

  // A slot takes a block: kept if it already holds part of this one (those bytes are
  // salvaged), else emptied.
  start(s, block, kind) {
    const resumable = this.slotGet(s, S_STATE) === SLOT_PARTIAL && this.slotGet(s, S_BLOCK) === block;
    if (!resumable) {
      this.filled[s] = [];
      this.tainted[s] = 0;
    }
    const got = rangeBytes(this.filled[s]);
    if (got > 0) this.counters[C_SALVAGED] += got;
    this.slotSet(s, SLOT_FILLING, block, got, kind);
    return this.request(s, block, kind);
  }

  // One HTTP request for the slot's next range: from the window of the read that wants
  // this block, if one does, else the first gap.
  request(s, block, kind) {
    const len = blockLength(block, this.size, this.blockSize);
    const ranges = this.filled[s];
    const prefer = this.urgent?.block === block ? this.urgent.from : null;
    const [start, end] = nextRange(ranges, len, prefer, this.windowAlign) ?? [len, len];
    const req = {
      slot: s, block, kind, start, end, pos: start, aborted: false, ended: false, ctrl: new AbortController(),
      sentAt: this.now(), firstAt: null, alone: this.receiving === 0 && this.inflight.size === 0
    };
    this.inflight.set(s, req);
    if (start >= end) {
      Promise.resolve().then(() => this.finish(req, null));
      return req;
    }
    if (start > firstMissing(ranges, 0, len)) this.counters[C_WINDOW_FIRST] += 1;
    const base = block * this.blockSize;
    this.fetchStream(this.url, base + start, base + end - 1, req.ctrl.signal, (chunk) => this.chunk(req, chunk)).then(
      (meta) => this.finish(req, meta),
      () => this.fail(req, { code: E_NETWORK, detail: 0 })
    );
    return req;
  }

  chunk(req, chunk) {
    if (req.aborted) return;
    this.measure(req, chunk.length);
    const s = req.slot;
    const n = Math.min(chunk.length, req.end - req.pos);
    if (n > 0) {
      this.slotData[s].set(n === chunk.length ? chunk : chunk.subarray(0, n), req.pos);
      addRange(this.filled[s], req.pos, req.pos + n);
      req.pos += n;
      Atomics.store(this.ctl, slotField(s, S_GOT), rangeBytes(this.filled[s]));
    }
    this.counters[C_BYTES] += chunk.length;
    // The read waiting on this block goes on as soon as its window is here.
    const d = this.demandReq;
    if (d && d.block === req.block && this.covered(s, d)) this.answer(s, true);
  }

  // The link: time to each response's first bytes (only for a request that had the link
  // to itself), and bytes over the time spent receiving -- from one chunk to the next
  // while any response is arriving, so idle time between requests doesn't count.
  measure(req, bytes) {
    const now = this.now();
    if (req.firstAt == null) {
      req.firstAt = now;
      if (req.alone) {
        const ms = now - req.sentAt;
        this.rtt = this.rtt ? this.rtt + (ms - this.rtt) / 4 : ms;
        this.rttMin = this.rttMin ? Math.min(this.rttMin, ms) : ms;
        this.counters[C_RTT_MS] = this.rtt;
        this.counters[C_RTT_MIN_MS] = this.rttMin;
      }
      if (this.receiving++ === 0) {
        this.linkAt = now;                     // these bytes' time went to waiting for them
        return;
      }
    }
    const dt = now - this.linkAt;
    this.linkAt = now;
    const keep = Math.exp(-dt / LINK_TAU_MS);
    this.linkBytes = this.linkBytes * keep + bytes;
    this.linkMs = this.linkMs * keep + dt;
    if (this.linkMs >= LINK_MIN_MS) this.counters[C_LINK_BPS] = (this.linkBytes / this.linkMs) * 1000;
  }

  endTransfer(req) {
    if (req.firstAt == null || req.ended) return;
    req.ended = true;
    if (--this.receiving === 0) this.linkAt = null;
  }

  check(meta) {
    if (meta.status !== 206) return { code: meta.status === 200 ? E_NO_RANGE : E_HTTP, detail: meta.status };
    if (meta.total != null && meta.total !== this.size) return { code: E_CHANGED, detail: 0 };
    if (meta.etag && this.etag && String(meta.etag).replace(/^W\//, "") !== this.etag) return { code: E_CHANGED, detail: 0 };
    if (meta.lastModified && this.lastModified && meta.lastModified !== this.lastModified) return { code: E_CHANGED, detail: 0 };
    return null;
  }

  finish(req, meta) {
    if (req.aborted || this.stopped) return undefined;
    const problem = meta ? this.check(meta) : null;
    if (problem && problem.code !== E_CHANGED) return this.fail(req, problem);
    if (req.pos !== req.end) return this.fail(req, { code: E_SHORT, detail: req.pos - req.start });
    this.endTransfer(req);
    this.inflight.delete(req.slot);
    if (req.end > req.start) this.counters[C_REQUESTS] += 1;
    this.failures = 0;
    const s = req.slot;
    if (problem) {
      this.sourceChanged();
      this.tainted[s] = 1;
    }
    if (firstMissing(this.filled[s], 0, blockLength(req.block, this.size, this.blockSize)) < 0) {
      return this.complete(s, req.block, req.kind);
    }
    // The server's current bytes still answer a read; a background block of a changed
    // disc is dropped.
    if (this.tainted[s] && req.kind !== KIND_DEMAND) return this.drop(s);
    this.request(s, req.block, req.kind);      // the rest: after the window, then the start
    return undefined;
  }

  // A whole block. One a read waited on goes to the discio worker (L1, and L2 where it
  // writes the copy) and, from here, to the copy; then the block after it, then the
  // stream. A background block goes to the copy, or to the discio worker to write.
  complete(s, block, kind) {
    const len = blockLength(block, this.size, this.blockSize);
    const tainted = this.tainted[s] === 1;
    const u = this.urgent?.block === block ? this.urgent : null;
    if (u) {
      const ms = this.now() - u.since;
      this.counters[C_BLOCKS] += 1;
      this.counters[C_BLOCK_MS] += ms;
      this.counters[C_BLOCK_LAST_MS] = ms;
      this.urgent = null;
    }
    this.tainted[s] = 0;
    if (u || kind === KIND_DEMAND) {
      this.slotSet(s, SLOT_READY, block, len, KIND_DEMAND);
      if (this.demandReq?.block === block) this.answer(s, true);
      else this.notifyReady();
      // The discio worker may be copying it out already; this thread writes from it
      // before doing anything else.
      if (!tainted) this.writeToStore(block, s);
      if (u) this.ahead(block + 1, { first: true });
      return this.pump();
    }
    if (tainted) return this.drop(s);
    if (this.store) {
      this.writeToStore(block, s);
      this.slotSet(s, SLOT_FREE, 0, 0, 0);
      return this.pump();
    }
    this.slotSet(s, SLOT_READY, block, len, kind);
    this.notifyReady();
    return this.pump();
  }

  drop(s) {
    this.filled[s] = [];
    this.tainted[s] = 0;
    this.slotSet(s, SLOT_FREE, 0, 0, 0);
    return this.pump();
  }

  // A request that ended early: its slot keeps what came (resumable) or is freed.
  park(req) {
    const s = req.slot;
    const got = rangeBytes(this.filled[s]);
    if (got === 0) {
      this.filled[s] = [];
      this.tainted[s] = 0;
    }
    this.slotSet(s, got > 0 ? SLOT_PARTIAL : SLOT_FREE, req.block, got, req.kind);
  }

  fail(req, problem) {
    if (req.aborted || this.stopped) return undefined;
    this.endTransfer(req);
    this.inflight.delete(req.slot);
    this.park(req);
    const u = this.urgent?.block === req.block ? this.urgent : null;
    if (u) {
      if (u.retries < this.demandRetries && retryable(problem)) {
        u.retries += 1;
        this.setTimer(() => {
          if (this.urgent !== u || this.stopped) return;
          let s = this.slotOf(u.block);
          if (s < 0) s = this.demandSlotFor();
          if (s >= 0 && !this.inflight.has(s)) this.start(s, u.block, KIND_DEMAND);
        }, this.retryBaseMs * u.retries);
        return undefined;
      }
      this.urgent = null;
      if (this.demandReq?.block === req.block) return this.failDemand(problem);
      return this.pump();
    }
    if (req.kind === KIND_SEQUENTIAL) {
      this.failures += 1;
      this.pausedUntil = this.now() + Math.min(30000, 500 * 2 ** Math.min(this.failures, 6));
    }
    return this.pump();
  }

  // Tell the discio worker its read can go on: slot s holds the window, or the whole
  // block (READY) for it to take.
  answer(s, waited) {
    const d = this.demandReq;
    if (!d) return false;
    this.demandReq = null;
    const whole = this.slotGet(s, S_STATE) === SLOT_READY;
    Atomics.store(this.ctl, H_DEMAND_SLOT, s);
    Atomics.store(this.ctl, H_DEMAND_INFO, (whole ? 0 : INFO_WINDOW) | (waited ? INFO_WAITED : 0) | (d.follow ? INFO_FOLLOW : 0));
    const waiting = demandWord(d.seq, DEMAND_WAITING);
    const taken = Atomics.compareExchange(this.ctl, H_DEMAND, waiting, demandWord(d.seq, DEMAND_DONE)) === waiting;
    Atomics.notify(this.ctl, H_DEMAND);
    // Nobody waits for it any more (the discio worker gave up on this demand): a whole
    // block is offered like any finished one.
    if (!taken && whole) this.notifyReady();
    return taken;
  }

  failDemand(problem) {
    const d = this.demandReq;
    this.demandReq = null;
    this.urgent = null;
    if (d) {
      Atomics.store(this.ctl, H_DEMAND_ERROR, problem.code);
      Atomics.store(this.ctl, H_DEMAND_DETAIL, problem.detail | 0);
      const waiting = demandWord(d.seq, DEMAND_WAITING);
      Atomics.compareExchange(this.ctl, H_DEMAND, waiting, demandWord(d.seq, DEMAND_FAILED));
      Atomics.notify(this.ctl, H_DEMAND);
    }
    return this.pump();
  }

  sourceChanged() {
    Atomics.or(this.ctl, H_FLAGS, FLAG_CHANGED);
    this.sequential = false;
    for (const req of [...this.inflight.values()]) if (req.kind === KIND_SEQUENTIAL) this.abort(req);
  }

  stopRequest(req) {
    req.aborted = true;
    try { req.ctrl.abort(); } catch { /* already settled */ }
    this.endTransfer(req);
    this.inflight.delete(req.slot);
  }

  abort(req) {
    this.stopRequest(req);
    this.counters[C_ABORTS] += 1;
    this.park(req);
  }

  // A slot for a background request: the one already holding part of this block (any,
  // the demand slot included), else a free one, else one holding part of another block
  // (that progress is let go). Never the one the discio worker is copying from.
  asyncSlotFor(block) {
    let free = -1;
    let partial = -1;
    for (let s = 0; s < this.layout.slots; s++) {
      if (this.pinned(s)) continue;
      const state = this.slotGet(s, S_STATE);
      if (state === SLOT_PARTIAL && this.slotGet(s, S_BLOCK) === block) return s;
      if (s === DEMAND_SLOT) continue;
      if (state === SLOT_FREE && free < 0) free = s;
      if (state === SLOT_PARTIAL && partial < 0) partial = s;
    }
    if (free >= 0) return free;
    if (partial >= 0) {
      this.slotSet(partial, SLOT_FREE, 0, 0, 0);
      return partial;
    }
    return -1;
  }

  nextJob() {
    while (this.aheadQueue.length) {
      const block = this.aheadQueue.shift();
      if (!this.present(block) && !this.busy(block)) return { block, kind: KIND_AHEAD };
    }
    if (!this.sequential) return null;
    const now = this.now();
    if (now < this.pausedUntil) {
      this.wakeAt(this.pausedUntil);
      return null;
    }
    if (this.cap > 0 && now < this.nextSequentialAt) {
      this.wakeAt(this.nextSequentialAt);
      return null;
    }
    // A read order's blocks first, in its order; then the rest from the start
    while (this.orderAt < this.order.length && this.present(this.order[this.orderAt])) this.orderAt += 1;
    for (let k = this.orderAt; k < this.order.length; k++) {
      const block = this.order[k];
      if (!this.present(block) && !this.busy(block)) return { block, kind: KIND_SEQUENTIAL };
    }
    while (this.cursor < this.blocks && this.present(this.cursor)) this.cursor += 1;
    for (let block = this.cursor; block < this.blocks; block++) {
      if (!this.present(block) && !this.busy(block)) return { block, kind: KIND_SEQUENTIAL };
    }
    return null;
  }

  pump() {
    if (this.stopped) return;
    if (!this.parked) {
      while (this.inflight.size < this.maxInFlight) {
        const job = this.nextJob();
        if (!job) break;
        const s = this.asyncSlotFor(job.block);
        if (s < 0) {
          if (job.kind === KIND_AHEAD) this.aheadQueue.unshift(job.block);
          break;                              // every slot is full; "freed" brings us back
        }
        if (job.kind === KIND_SEQUENTIAL && this.cap > 0) {
          const len = blockLength(job.block, this.size, this.blockSize);
          this.nextSequentialAt = Math.max(this.now(), this.nextSequentialAt) + (len / this.cap) * 1000;
        }
        this.start(s, job.block, job.kind);
      }
      // A block ahead of a read outranks the sequential stream: with both requests
      // taken by it, the furthest one steps aside, keeping what it got.
      if (this.aheadQueue.length && this.inflight.size >= this.maxInFlight) {
        const victim = [...this.inflight.values()]
          .filter((req) => req.kind === KIND_SEQUENTIAL)
          .sort((a, b) => b.block - a.block)[0];
        if (victim) {
          this.abort(victim);
          return this.pump();
        }
      }
    }
    this.updateSequentialState();
  }

  wakeAt(at) {
    if (this.timer != null && this.timerAt <= at) return;
    if (this.timer != null) this.clearTimer(this.timer);
    this.timerAt = at;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.timerAt = Infinity;
      this.pump();
    }, Math.max(0, at - this.now()));
  }

  updateSequentialState() {
    let state = SEQ_OFF;
    if (this.sequential) {
      while (this.cursor < this.blocks && this.present(this.cursor)) this.cursor += 1;
      if (this.cursor >= this.blocks) state = SEQ_DONE;
      else if (this.parked) state = SEQ_PARKED;
      else if (this.now() < this.pausedUntil) state = SEQ_PAUSED;
      else state = SEQ_RUNNING;
    }
    Atomics.store(this.ctl, H_SEQ_STATE, state);
  }

  async stop() {
    this.stopped = true;
    for (const req of [...this.inflight.values()]) this.abort(req);
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = null;
    if (this.persistTimer != null) this.clearTimer(this.persistTimer);
    this.persistTimer = null;
    const store = this.store;
    this.store = null;
    if (store) {
      try { await store.close(); } catch { /* best effort on the way out */ }
      store.release?.();
    }
    this.post({ type: "stopped" });
  }
}


/**
 * This device's copy, opened by the fetch worker to write: under a Web Lock per disc
 * (shared handles would otherwise let a second tab write the same files), with the image
 * handle shared so the discio worker can read beside it. -> { ok, writer, store, reason,
 * note }. `writer: false` means this browser can't share the handle; the discio worker
 * then owns the copy itself.
 */
export async function openWriterStore({ source, bitmapBytes, getRoot, estimate = null, locks, blockSize = RANGE_BLOCK }) {
  if (!getRoot || typeof locks?.request !== "function") return { ok: false, writer: false };
  const key = discCacheKey(source.url);
  let release = () => {};
  const held = new Promise((resolve) => { release = resolve; });
  const locked = await new Promise((resolve) => {
    locks.request(`wasm-dolphin-disc:${key}`, { ifAvailable: true }, (lock) => {
      resolve(Boolean(lock));
      return lock ? held : undefined;
    }).catch(() => resolve(false));
  });
  if (!locked) return { ok: false, writer: true, reason: "the copy on this device is open in another tab" };
  try {
    const bitmap = new BlockBitmap(blockCount(source.size, blockSize), bitmapBytes);
    const opened = await OpfsDiscStore.open({ root: await getRoot(), source, key, blockSize, bitmap, estimate, shared: true });
    if (!opened.store) {
      release();
      return { ok: false, writer: true, reason: opened.reason, note: opened.note };
    }
    if (!opened.store.shared) {
      await opened.store.close().catch(() => {});
      release();
      return { ok: false, writer: false, note: opened.note };
    }
    opened.store.release = release;
    return { ok: true, writer: true, store: opened.store, note: opened.note };
  } catch (error) {
    release();
    return { ok: false, writer: true, reason: `this device's storage is unavailable (${error?.message || error})` };
  }
}

// The discio worker's side. demand() blocks (Atomics.wait) until the fetcher answers;
// the rest are messages or reads of the shared buffer.
export class FetchWorkerClient {
  constructor({
    buffer,
    layout,
    port,
    terminate = () => {},
    storeReport = null,
    now = () => performance.now(),
    waitSliceMs = 1000,
    demandTimeoutMs = 90000
  }) {
    this.kind = "worker";
    this.storeReport = storeReport;
    this.lostReason = null;
    this.waiters = new Map();
    this.layout = layout;
    const views = sharedViews(buffer, layout);
    this.ctl = views.ctl;
    this.countersView = views.counters;
    this.bitmapBytes = views.bitmap;
    this.slotData = views.slots;
    this.port = port;
    this.terminate = terminate;
    this.now = now;
    this.waitSliceMs = waitSliceMs;
    this.demandTimeoutMs = demandTimeoutMs;
    this.seq = 0;
    this.onReady = null;
    this.closed = false;
    port.addEventListener("message", (event) => {
      const type = event.data?.type;
      if (type === "ready") this.onReady?.();
      else if (type === "storeLost") {
        this.lostReason = event.data.reason;
        this.onReady?.();
      } else if (this.waiters.has(type)) {
        for (const resolve of this.waiters.get(type)) resolve(event.data);
        this.waiters.delete(type);
      }
    });
  }

  waitFor(type, timeoutMs) {
    return new Promise((resolve) => {
      const list = this.waiters.get(type) ?? [];
      list.push(resolve);
      this.waiters.set(type, list);
      setTimeout(() => resolve(null), timeoutMs);
    });
  }

  takeSlot(s, block) {
    if (Atomics.load(this.ctl, slotField(s, S_BLOCK)) !== block) {
      throw new Error(`disc block ${block}: the fetch worker answered with block ${Atomics.load(this.ctl, slotField(s, S_BLOCK))}`);
    }
    const len = blockLength(block, this.layout.size, this.layout.blockSize);
    const bytes = this.slotData[s].slice(0, len);
    Atomics.store(this.ctl, slotField(s, S_STATE), SLOT_FREE);
    return bytes;
  }

  // Copy a window out of a slot the fetcher is still filling: it answered because those
  // bytes are there, and it writes nothing over them while the demand word says so.
  takeWindow(s, block, from, len) {
    if (Atomics.load(this.ctl, slotField(s, S_BLOCK)) !== block) {
      throw new Error(`disc block ${block}: the fetch worker answered with block ${Atomics.load(this.ctl, slotField(s, S_BLOCK))}`);
    }
    const end = len == null ? blockLength(block, this.layout.size, this.layout.blockSize) : from + len;
    return this.slotData[s].slice(from, end);
  }

  // -> { bytes, from, waited, filling, follow }: `bytes` are the block's from `from` --
  // the whole block (from 0) when it had arrived, else just the window asked for, which
  // is all a block still arriving can give. `waited`: the read waited on the network.
  demand(block, from = 0, len = null) {
    for (let s = 0; s < this.layout.slots; s++) {
      if (Atomics.load(this.ctl, slotField(s, S_STATE)) === SLOT_READY &&
          Atomics.load(this.ctl, slotField(s, S_BLOCK)) === block) {
        const bytes = this.takeSlot(s, block);
        this.freed();
        return { bytes, from: 0, waited: false };
      }
    }
    this.seq = (this.seq + 1) & 0x1fffffff;
    const waiting = demandWord(this.seq, DEMAND_WAITING);
    Atomics.store(this.ctl, H_DEMAND, waiting);
    this.port.postMessage({ type: "demand", block, from, len, seq: this.seq });
    const deadline = this.now() + this.demandTimeoutMs;
    let word = Atomics.load(this.ctl, H_DEMAND);
    while (word === waiting) {
      const left = deadline - this.now();
      if (left <= 0) break;
      Atomics.wait(this.ctl, H_DEMAND, waiting, Math.min(this.waitSliceMs, left));
      word = Atomics.load(this.ctl, H_DEMAND);
    }
    if (word === demandWord(this.seq, DEMAND_DONE)) {
      const s = Atomics.load(this.ctl, H_DEMAND_SLOT);
      const info = Atomics.load(this.ctl, H_DEMAND_INFO);
      const waited = (info & INFO_WAITED) !== 0;
      const follow = (info & INFO_FOLLOW) !== 0;
      // Whole by now (it may have finished since the answer): taken, as a finished block is.
      if (Atomics.load(this.ctl, slotField(s, S_STATE)) === SLOT_READY) {
        const bytes = this.takeSlot(s, block);
        Atomics.store(this.ctl, H_DEMAND, demandWord(this.seq, DEMAND_IDLE));
        this.freed();
        return { bytes, from: 0, waited, follow };
      }
      try {
        return { bytes: this.takeWindow(s, block, from, len), from, waited, filling: true, follow };
      } finally {
        Atomics.store(this.ctl, H_DEMAND, demandWord(this.seq, DEMAND_IDLE));
      }
    }
    Atomics.store(this.ctl, H_DEMAND, demandWord(this.seq, DEMAND_IDLE));
    if (word === demandWord(this.seq, DEMAND_FAILED)) {
      throw new Error(describeFetchError(Atomics.load(this.ctl, H_DEMAND_ERROR), Atomics.load(this.ctl, H_DEMAND_DETAIL), block));
    }
    throw new Error(`disc block ${block}: no answer in ${Math.round(this.demandTimeoutMs / 1000)} s`);
  }

  ahead(block) {
    this.port.postMessage({ type: "ahead", block });
  }

  // Finished blocks the fetcher offers, a block a read waited on (in any slot) included.
  drainReady(take) {
    let any = false;
    for (let s = 0; s < this.layout.slots; s++) {
      if (Atomics.load(this.ctl, slotField(s, S_STATE)) !== SLOT_READY) continue;
      const block = Atomics.load(this.ctl, slotField(s, S_BLOCK));
      const kind = Atomics.load(this.ctl, slotField(s, S_KIND));
      const len = blockLength(block, this.layout.size, this.layout.blockSize);
      try {
        take(block, kind === KIND_SEQUENTIAL ? KIND_SEQUENTIAL : KIND_AHEAD, this.slotData[s].subarray(0, len));
      } finally {
        Atomics.store(this.ctl, slotField(s, S_STATE), SLOT_FREE);
        any = true;
      }
    }
    if (any) this.freed();
  }

  freed() {
    this.port.postMessage({ type: "freed" });
  }

  setSequential(on, cap = 0) {
    this.port.postMessage({ type: "sequential", on: Boolean(on), cap });
  }

  setOrder(blocks) {
    this.port.postMessage({ type: "order", blocks: Array.from(blocks) });
  }

  get changed() {
    return (Atomics.load(this.ctl, H_FLAGS) & FLAG_CHANGED) !== 0;
  }

  // The fetch worker could no longer write this device's copy: why, once it has said.
  get storeLost() {
    if (!(Atomics.load(this.ctl, H_FLAGS) & FLAG_STORE_LOST)) return null;
    return this.lostReason ?? "writing to this device failed";
  }

  get storeComplete() {
    return (Atomics.load(this.ctl, H_FLAGS) & FLAG_STORE_COMPLETE) !== 0;
  }

  dropStore({ remove = false } = {}) {
    const dropped = this.waitFor("storeDropped", 5000);
    this.port.postMessage({ type: "dropStore", remove });
    return dropped;
  }

  flushStore() {
    this.port.postMessage({ type: "flush" });
  }

  busy() {
    return { writeMs: Math.round(this.countersView[C_WRITE_MS]), persistMs: Math.round(this.countersView[C_PERSIST_MS]) };
  }

  counters() {
    const c = this.countersView;
    return {
      bytes: c[C_BYTES], requests: c[C_REQUESTS], salvaged: c[C_SALVAGED], aborts: c[C_ABORTS], demands: c[C_DEMANDS],
      restarts: c[C_RESTARTS], windowFirst: c[C_WINDOW_FIRST],
      blocks: c[C_BLOCKS], blockMs: c[C_BLOCK_MS], lastBlockMs: c[C_BLOCK_LAST_MS]
    };
  }

  // The fetcher's estimate of the link: bytes per second while receiving, time to first
  // bytes (smoothed, and the shortest); zeros until it has seen enough.
  link() {
    const c = this.countersView;
    return { bytesPerSecond: c[C_LINK_BPS], rttMs: c[C_RTT_MS], rttMinMs: c[C_RTT_MIN_MS] };
  }

  sequentialState() {
    return SEQ_NAMES[Atomics.load(this.ctl, H_SEQ_STATE)] ?? "off";
  }

  // The fetch worker persists and closes the copy before it goes; it gets two seconds.
  async close() {
    if (this.closed) return;
    this.closed = true;
    const stopped = this.waitFor("stopped", 2000);
    try { this.port.postMessage({ type: "stop" }); } catch { /* worker gone */ }
    await stopped;
    this.terminate();
  }
}

// Without a fetch worker (no SharedArrayBuffer, no nested workers): the reader as it was
// before the tiers -- a miss is a synchronous XHR in the discio worker, the block ahead
// an ordinary fetch. There is no sequential stream: in this thread it could not be
// parked while the core waits, and it would slow every miss down.
export class InlineFetcher {
  constructor({ url, size, blockSize = RANGE_BLOCK, createXhr = () => new XMLHttpRequest(), fetchImpl = (...args) => fetch(...args) }) {
    this.kind = "inline";
    this.url = url;
    this.size = size;
    this.blockSize = blockSize;
    this.createXhr = createXhr;
    this.fetchImpl = fetchImpl;
    this.bitmapBytes = null;
    this.onReady = null;
    this.changed = false;
    this.ready = new Map();
    this.inflight = new Map();
    this.stats = { bytes: 0, requests: 0, salvaged: 0, aborts: 0, demands: 0, restarts: 0, windowFirst: 0, blocks: 0, blockMs: 0, lastBlockMs: 0 };
    this.now = () => performance.now();
  }

  range(block) {
    const start = block * this.blockSize;
    return [start, start + blockLength(block, this.size, this.blockSize) - 1];
  }

  demand(block) {
    const done = this.ready.get(block);
    if (done) {
      this.ready.delete(block);
      return { bytes: done, waited: false };
    }
    const [a, b] = this.range(block);
    const t0 = this.now();
    const x = this.createXhr();
    x.open("GET", this.url, false);
    x.responseType = "arraybuffer";
    x.setRequestHeader("Range", `bytes=${a}-${b}`);
    x.send();
    this.stats.demands++;
    if (x.status !== 206) throw new Error(x.status === 200 ? "the server ignored the Range request" : `disc read failed: HTTP ${x.status}`);
    const bytes = new Uint8Array(x.response);
    if (bytes.length !== b - a + 1) throw new Error(`short disc read (${bytes.length} of ${b - a + 1})`);
    this.stats.requests++;
    this.stats.bytes += bytes.length;
    const ms = this.now() - t0;                 // here the window and the whole block arrive together
    this.stats.blocks++;
    this.stats.blockMs += ms;
    this.stats.lastBlockMs = ms;
    return { bytes, from: 0, waited: true };
  }

  ahead(block) {
    if (this.ready.has(block) || this.inflight.has(block) || this.inflight.size >= MAX_IN_FLIGHT) return;
    const [a, b] = this.range(block);
    const ctrl = new AbortController();
    this.inflight.set(block, ctrl);
    this.fetchImpl(this.url, { headers: { Range: `bytes=${a}-${b}` }, credentials: "same-origin", cache: "no-store", signal: ctrl.signal })
      .then(async (r) => {
        if (r.status !== 206) {
          try { await r.body?.cancel(); } catch { /* nothing to drain */ }
          return;
        }
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (bytes.length !== b - a + 1) return;
        this.stats.requests++;
        this.stats.bytes += bytes.length;
        this.ready.set(block, bytes);
        this.onReady?.();
      })
      .catch(() => {})
      .finally(() => this.inflight.delete(block));
  }

  drainReady(take) {
    for (const [block, bytes] of this.ready) take(block, KIND_AHEAD, bytes);
    this.ready.clear();
  }

  setSequential() {}

  setOrder() {}

  counters() {
    return { ...this.stats };
  }

  sequentialState() {
    return "off";
  }

  async close() {
    for (const ctrl of this.inflight.values()) ctrl.abort();
    this.inflight.clear();
  }
}

/**
 * The fetcher for a disc, in the discio worker: a fetch worker over shared memory when
 * the browser allows (it answers a hello before anything relies on it), else inline.
 */
export async function createDiscFetcher(source, {
  opfs = true,
  workerUrl = new URL("./remote-disc-fetch-worker.js", import.meta.url),
  WorkerImpl = globalThis.Worker,
  handshakeMs = 15000,
  log = () => {}
} = {}) {
  const validators = { etag: source.etag ?? null, lastModified: source.lastModified ?? null };
  if (typeof SharedArrayBuffer === "function" && typeof WorkerImpl === "function") {
    let worker = null;
    try {
      const layout = fetchSharedLayout({ size: source.size });
      const buffer = new SharedArrayBuffer(layout.byteLength);
      worker = new WorkerImpl(workerUrl, { type: "module", name: "dolphin-disc-fetch" });
      const hello = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no answer from it")), handshakeMs);
        worker.addEventListener("message", (event) => {
          if (event.data?.type === "hello") {
            clearTimeout(timer);
            resolve(event.data.store ?? null);
          }
        });
        worker.addEventListener("error", (event) => {
          clearTimeout(timer);
          reject(new Error(event?.message || "it failed to start"));
        });
      });
      const store = opfs ? { name: source.name, etag: source.etag ?? null, lastModified: source.lastModified ?? null } : null;
      worker.postMessage({ type: "init", url: source.url, size: source.size, blockSize: RANGE_BLOCK, validators, buffer, layout, store });
      const storeReport = await hello;
      return new FetchWorkerClient({ buffer, layout, port: worker, terminate: () => worker.terminate(), storeReport });
    } catch (error) {
      try { worker?.terminate(); } catch { /* never started */ }
      log(`no fetch worker (${error?.message || error}); misses are read in this thread and nothing is fetched in the background`);
    }
  }
  return new InlineFetcher({ url: source.url, size: source.size });
}
