// L3 for a remote disc: every HTTP request goes through a fetch worker of its own.
//
// Why a second worker: a read the core is waiting on has to be answered synchronously
// (WORKERFS is synchronous), so the discio worker blocks until the block arrives. A
// fetch in the discio worker can't be aborted while it blocks -- the cancellation only
// reaches the network once its event loop turns, which measured the same as not
// aborting at all (a 4 MiB miss beside two streaming requests: 1.09 s aborted vs 1.11 s
// not, 0.43 s alone, on a shared 100 Mbit link). A fetch worker's loop stays free, so a
// miss can park the sequential stream at once and have the link to itself.
//
// The two workers share one SharedArrayBuffer (fetchSharedLayout):
//   - a control block: the demand word (sequence << 2 | state), its answer, flags, and
//     a small table of slots (state, block, bytes so far, kind);
//   - counters (bytes received, requests, bytes salvaged from parked requests, aborts);
//   - the L2 bitmap, which only the discio worker writes and the fetcher reads to know
//     what it need not fetch;
//   - the slots' data, one block each. Slot 0 is the demand's own; the others hold the
//     at most two requests in flight and finished blocks the discio worker hasn't taken.
//
// A miss: the discio worker takes the block from a finished slot if one has it, else
// posts {demand} and waits on the demand word. The fetcher aborts every other request
// (each keeps what it got; a later request resumes from there), continues the block if
// it was already on its way or starts it in slot 0, and answers. Then it resumes: one
// block ahead of the miss first, then the sequential stream.
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

const H_DEMAND = 0;
const H_DEMAND_SLOT = 1;
const H_DEMAND_ERROR = 2;
const H_DEMAND_DETAIL = 3;
const H_FLAGS = 4;
const H_SEQ_STATE = 5;
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
const COUNTERS = 8;
const PERSIST_INTERVAL_MS = 5000;
const META_INTERVAL_MS = 15000;

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

// One Range request, its body handed over chunk by chunk as it arrives (so an abort
// keeps what came). A response that isn't 206 is not read: with the Range ignored it
// would be the whole image.
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
    retryBaseMs = 250
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
    this.inflight = new Map();          // slot -> request
    this.parked = false;
    this.demandReq = null;
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
  }

  handle(message) {
    switch (message?.type) {
      case "demand":
        return this.demand(message.block, message.seq);
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

  present(block) {
    return (Atomics.load(this.bitmap, block >> 3) & (1 << (block & 7))) !== 0;
  }

  busy(block) {
    return this.findSlot(block, SLOT_FILLING) >= 0 || this.findSlot(block, SLOT_READY) >= 0;
  }

  demand(block, seq) {
    if (this.stopped) return;
    this.counters[C_DEMANDS] += 1;
    this.demandReq = { seq, block, retries: 0 };
    const ready = this.findSlot(block, SLOT_READY);
    if (ready >= 0) return this.answer(ready);
    this.parked = true;
    this.updateSequentialState();
    // A miss outranks everything: every other request stops now, keeping what it got.
    for (const req of [...this.inflight.values()]) if (req.block !== block) this.abort(req);
    const running = [...this.inflight.values()].find((req) => req.block === block);
    if (running) {
      running.kind = KIND_DEMAND;
      Atomics.store(this.ctl, slotField(running.slot, S_KIND), KIND_DEMAND);
      return;
    }
    const partial = this.findSlot(block, SLOT_PARTIAL);
    this.start(partial >= 0 ? partial : DEMAND_SLOT, block, KIND_DEMAND);
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

  start(s, block, kind) {
    const len = blockLength(block, this.size, this.blockSize);
    const resumable = this.slotGet(s, S_STATE) === SLOT_PARTIAL && this.slotGet(s, S_BLOCK) === block;
    const got = resumable ? Math.min(this.slotGet(s, S_GOT), len) : 0;
    if (got > 0) this.counters[C_SALVAGED] += got;
    this.slotSet(s, SLOT_FILLING, block, got, kind);
    const req = { slot: s, block, kind, got, len, aborted: false, ctrl: new AbortController() };
    this.inflight.set(s, req);
    if (got >= len) {
      Promise.resolve().then(() => this.finish(req, null));
      return req;
    }
    const data = this.slotData[s];
    const base = block * this.blockSize;
    this.fetchStream(this.url, base + got, base + len - 1, req.ctrl.signal, (chunk) => {
      if (req.aborted) return;
      const n = Math.min(chunk.length, len - req.got);
      if (n > 0) data.set(n === chunk.length ? chunk : chunk.subarray(0, n), req.got);
      req.got += n;
      Atomics.store(this.ctl, slotField(s, S_GOT), req.got);
      this.counters[C_BYTES] += chunk.length;
    }).then(
      (meta) => this.finish(req, meta),
      () => this.fail(req, { code: E_NETWORK, detail: 0 })
    );
    return req;
  }

  check(meta) {
    if (meta.status !== 206) return { code: meta.status === 200 ? E_NO_RANGE : E_HTTP, detail: meta.status };
    if (meta.total != null && meta.total !== this.size) return { code: E_CHANGED, detail: 0 };
    if (meta.etag && this.etag && String(meta.etag).replace(/^W\//, "") !== this.etag) return { code: E_CHANGED, detail: 0 };
    if (meta.lastModified && this.lastModified && meta.lastModified !== this.lastModified) return { code: E_CHANGED, detail: 0 };
    return null;
  }

  finish(req, meta) {
    if (req.aborted || this.stopped) return;
    const problem = meta ? this.check(meta) : null;
    if (problem && problem.code !== E_CHANGED) return this.fail(req, problem);
    if (req.got !== req.len) return this.fail(req, { code: E_SHORT, detail: req.got });
    this.inflight.delete(req.slot);
    this.counters[C_REQUESTS] += 1;
    this.failures = 0;
    if (problem) this.sourceChanged();
    // The server's current bytes still answer a miss; a background block of a changed
    // disc is dropped.
    if (req.kind === KIND_DEMAND && this.demandReq?.block === req.block) {
      this.answer(req.slot);
      // The discio worker is already copying the block out; the slot stays its until it
      // frees it, and this thread writes from it before doing anything else.
      if (!problem) this.writeToStore(req.block, req.slot);
      return undefined;
    }
    if (problem) {
      this.slotSet(req.slot, SLOT_FREE, 0, 0, 0);
      return this.pump();
    }
    if (this.store) {
      this.writeToStore(req.block, req.slot);
      this.slotSet(req.slot, SLOT_FREE, 0, 0, 0);
      return this.pump();
    }
    this.slotSet(req.slot, SLOT_READY, req.block, req.got, req.kind);
    this.notifyReady();
    return this.pump();
  }

  fail(req, problem) {
    if (req.aborted || this.stopped) return;
    this.inflight.delete(req.slot);
    this.slotSet(req.slot, req.got > 0 ? SLOT_PARTIAL : SLOT_FREE, req.block, req.got, req.kind);
    if (req.kind === KIND_DEMAND) {
      const d = this.demandReq;
      if (!d || d.block !== req.block) return this.pump();
      if (d.retries < this.demandRetries && retryable(problem)) {
        d.retries += 1;
        this.setTimer(() => {
          if (this.demandReq !== d || this.stopped) return;
          const partial = this.findSlot(d.block, SLOT_PARTIAL);
          this.start(partial >= 0 ? partial : DEMAND_SLOT, d.block, KIND_DEMAND);
        }, this.retryBaseMs * d.retries);
        return;
      }
      return this.failDemand(problem);
    }
    if (req.kind === KIND_SEQUENTIAL) {
      this.failures += 1;
      this.pausedUntil = this.now() + Math.min(30000, 500 * 2 ** Math.min(this.failures, 6));
    }
    return this.pump();
  }

  answer(s) {
    const block = this.slotGet(s, S_BLOCK);
    const d = this.demandReq?.block === block ? this.demandReq : null;
    if (this.slotGet(s, S_STATE) !== SLOT_READY) {
      this.slotSet(s, SLOT_READY, block, blockLength(block, this.size, this.blockSize), KIND_DEMAND);
    }
    this.demandReq = null;
    this.parked = false;
    if (d) {
      Atomics.store(this.ctl, H_DEMAND_SLOT, s);
      const waiting = demandWord(d.seq, DEMAND_WAITING);
      const taken = Atomics.compareExchange(this.ctl, H_DEMAND, waiting, demandWord(d.seq, DEMAND_DONE)) === waiting;
      Atomics.notify(this.ctl, H_DEMAND);
      // Nobody waits for it any more (the discio worker gave up on this demand): slot 0
      // is simply freed, a background slot is offered like any finished block.
      if (!taken && s === DEMAND_SLOT) this.slotSet(s, SLOT_FREE, 0, 0, 0);
      else if (!taken) this.notifyReady();
    }
    this.ahead(block + 1, { first: true });   // one block ahead of the miss, before the stream resumes
    return this.pump();
  }

  failDemand(problem) {
    const d = this.demandReq;
    this.demandReq = null;
    this.parked = false;
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

  abort(req) {
    req.aborted = true;
    try { req.ctrl.abort(); } catch { /* already settled */ }
    this.inflight.delete(req.slot);
    this.counters[C_ABORTS] += 1;
    this.slotSet(req.slot, req.got > 0 ? SLOT_PARTIAL : SLOT_FREE, req.block, req.got, req.kind);
  }

  // A slot for a background request: the one already holding part of this block, else a
  // free one, else one holding part of another block (that progress is let go).
  asyncSlotFor(block) {
    let free = -1;
    let partial = -1;
    for (let s = DEMAND_SLOT + 1; s < this.layout.slots; s++) {
      const state = this.slotGet(s, S_STATE);
      if (state === SLOT_PARTIAL && this.slotGet(s, S_BLOCK) === block) return s;
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

  demand(block) {
    for (let s = DEMAND_SLOT + 1; s < this.layout.slots; s++) {
      if (Atomics.load(this.ctl, slotField(s, S_STATE)) === SLOT_READY &&
          Atomics.load(this.ctl, slotField(s, S_BLOCK)) === block) {
        const bytes = this.takeSlot(s, block);
        this.freed();
        return { bytes, waited: false };
      }
    }
    this.seq = (this.seq + 1) & 0x1fffffff;
    const waiting = demandWord(this.seq, DEMAND_WAITING);
    Atomics.store(this.ctl, H_DEMAND, waiting);
    this.port.postMessage({ type: "demand", block, seq: this.seq });
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
      const bytes = this.takeSlot(s, block);
      Atomics.store(this.ctl, H_DEMAND, demandWord(this.seq, DEMAND_IDLE));
      if (s !== DEMAND_SLOT) this.freed();
      return { bytes, waited: true };
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

  drainReady(take) {
    let any = false;
    for (let s = DEMAND_SLOT + 1; s < this.layout.slots; s++) {
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
    return { bytes: c[C_BYTES], requests: c[C_REQUESTS], salvaged: c[C_SALVAGED], aborts: c[C_ABORTS], demands: c[C_DEMANDS] };
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
    this.stats = { bytes: 0, requests: 0, salvaged: 0, aborts: 0, demands: 0 };
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
    return { bytes, waited: true };
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
