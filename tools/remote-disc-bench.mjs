// Remote-disc benchmark: the ?disc= reader (src/remote-disc.js, remote-disc-fetch.js) in
// a real browser worker, against a throttled disc server, replaying a model of a game
// session's disc reads. It compares the reader from before the tiers (dolphin-browser's
// RangeDisc: 64 blocks in memory, a synchronous XHR per miss, one block prefetched)
// with the tiered one, on a first launch and on a second launch in the same profile.
//
//   node tools/remote-disc-bench.mjs [--size-mb 1400] [--delay-ms 40] [--bw-mbit 100]
//        [--duration 240] [--scenarios before,first,second,noprefetch,downloadfirst]
//        [--per-request-bw] [--trace heavy|light|menus] [--seed 1] [--headed] [--out <dir>]
//        [--port 8095]
//
// --bw-mbit 0 is unlimited. The link is shared by every disc response at once, as a
// real one is; --per-request-bw caps each response on its own instead (as a simple test
// server does), which hides the cost of a background request beside a miss.
//
// No game data anywhere: the disc is generated, every byte a function of its offset, so
// each read is checked; the trace is a model, not a recording. What it measures is the
// reader: how often and how long a read waits on the network, how many bytes cross the
// network, and how late a 10 ms timer runs on the reading thread (a stand-in for the
// discio worker's other work). It does not measure game speed.

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = argv[i + 1];
  return next === undefined || next.startsWith("--") ? true : next;
};
const options = {
  sizeMb: Number(flag("size-mb", 1400)),
  delayMs: Number(flag("delay-ms", 40)),
  bwMbit: Number(flag("bw-mbit", 100)),
  duration: Number(flag("duration", 240)),
  scenarios: String(flag("scenarios", "before,first,second,noprefetch,downloadfirst")).split(",").filter(Boolean),
  perRequestBw: Boolean(flag("per-request-bw", false)),
  trace: String(flag("trace", "heavy")),
  seed: Number(flag("seed", 1)),
  headed: Boolean(flag("headed", false)),
  port: Number(flag("port", 8095)),
  out: path.resolve(String(flag("out", path.join(root, "build", "remote-disc-bench"))))
};
const SIZE = Math.round(options.sizeMb * 1e6);
const SLICE = 128 * 1024;
const LAST_MODIFIED = "Thu, 01 Oct 2026 00:00:00 GMT";
const ETAG = `"synthetic-${SIZE}-${options.seed}"`;

// ── the disc: a 65521-byte seeded pattern, xor the 4 KiB page number ───────────────
const PATTERN_SOURCE = `
const PATTERN_LENGTH = 65521;
function makePattern(seed) {
  let s = seed >>> 0;
  const out = new Uint8Array(PATTERN_LENGTH);
  for (let i = 0; i < out.length; i++) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
  }
  return out;
}
function fillDisc(pattern, out, offset) {
  let j = offset % PATTERN_LENGTH;
  for (let i = 0; i < out.length; i++) {
    out[i] = pattern[j] ^ (Math.floor((offset + i) / 4096) & 0xff);
    if (++j === PATTERN_LENGTH) j = 0;
  }
  return out;
}
`;
const { makePattern, fillDisc } = new Function(`${PATTERN_SOURCE}; return { makePattern, fillDisc };`)();
const PATTERN = makePattern(options.seed);

// ── the session model ──────────────────────────────────────────────────────────────
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Boot (header, apploader, FST, the main DOL, a dozen small files), menus (a few files
// every few seconds for the first minute), then a "course" every 20-30 s: one large
// file, several small ones, and background music streamed at 256 KiB/s from its own
// file. Offsets are uniform over the disc, which is harsher than a real layout. "light"
// keeps the boot and spaces everything else out (a course every 40-60 s, 8-20 MB, two
// to four small files, no menu churn after 30 s), nearer a session where the old reader
// waited a dozen times.
function makeTrace({ size, duration, seed, kind = "heavy" }) {
  if (kind === "light") return makeLightTrace({ size, duration, seed });
  if (kind === "menus") return makeMenuTrace({ size, duration, seed });
  const rnd = mulberry32(seed);
  const loads = [];
  const between = (a, b) => a + rnd() * (b - a);
  const anywhere = (length) => Math.floor((rnd() * Math.max(0, size - length)) / 2048) * 2048;
  const add = (t, offset, length, kind) => {
    if (t >= duration * 1000) return;
    loads.push({ t: Math.round(t), offset, length: Math.min(length, size - offset), kind });
  };
  add(0, 0, 0x8010, "header");
  add(200, 0x2440, 0x30000, "apploader");
  add(400, Math.floor(size * 0.0004 / 2048) * 2048, 1 << 20, "fst");
  add(700, anywhere(4 << 20), 4 << 20, "dol");
  for (let i = 0; i < 12; i++) add(1200 + i * 400, anywhere(2 << 20), Math.round(between(64 << 10, 2 << 20)), "boot");
  for (let t = 8000; t < 60000; t += between(3000, 6000)) {
    const files = 2 + Math.floor(rnd() * 4);
    for (let i = 0; i < files; i++) add(t + i * 150, anywhere(6 << 20), Math.round(between(128 << 10, 6 << 20)), "menu");
  }
  for (let t = 60000; t < duration * 1000; t += between(20000, 30000)) {
    add(t, anywhere(45 << 20), Math.round(between(15 << 20, 45 << 20)), "course");
    const small = 4 + Math.floor(rnd() * 7);
    for (let i = 0; i < small; i++) add(t + 500 + i * 200, anywhere(2 << 20), Math.round(between(64 << 10, 2 << 20)), "course-file");
    const stream = anywhere(24 << 20);
    for (let s = 0; s < 20 && stream + s * (256 << 10) < size; s++) add(t + 3000 + s * 1000, stream + s * (256 << 10), 256 << 10, "music");
  }
  return loads.sort((a, b) => a.t - b.t);
}

function makeLightTrace({ size, duration, seed }) {
  const rnd = mulberry32(seed);
  const loads = [];
  const between = (a, b) => a + rnd() * (b - a);
  const anywhere = (length) => Math.floor((rnd() * Math.max(0, size - length)) / 2048) * 2048;
  const add = (t, offset, length, kind) => {
    if (t >= duration * 1000) return;
    loads.push({ t: Math.round(t), offset, length: Math.min(length, size - offset), kind });
  };
  add(0, 0, 0x8010, "header");
  add(200, 0x2440, 0x30000, "apploader");
  add(400, Math.floor(size * 0.0004 / 2048) * 2048, 1 << 20, "fst");
  add(700, anywhere(4 << 20), 4 << 20, "dol");
  for (let i = 0; i < 8; i++) add(1200 + i * 500, anywhere(1 << 20), Math.round(between(64 << 10, 1 << 20)), "boot");
  for (let t = 10000; t < 30000; t += between(6000, 9000)) add(t, anywhere(3 << 20), Math.round(between(256 << 10, 3 << 20)), "menu");
  for (let t = 40000; t < duration * 1000; t += between(40000, 60000)) {
    add(t, anywhere(20 << 20), Math.round(between(8 << 20, 20 << 20)), "course");
    const small = 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < small; i++) add(t + 500 + i * 300, anywhere(1 << 20), Math.round(between(64 << 10, 1 << 20)), "course-file");
  }
  return loads.sort((a, b) => a.t - b.t);
}

// "menus": a boot, then the title's menus -- small files (16 KiB to 1 MiB, most of them
// under 256 KiB) every few seconds, a third of them right after the one before. Nearer a
// cold boot into the menus, where each wait is a small read in a block not yet here.
function makeMenuTrace({ size, duration, seed }) {
  const rnd = mulberry32(seed);
  const loads = [];
  const between = (a, b) => a + rnd() * (b - a);
  const small = () => Math.round(Math.exp(between(Math.log(16 << 10), Math.log(1 << 20))) / 2048) * 2048;
  const anywhere = (length) => Math.floor((rnd() * Math.max(0, size - length)) / 2048) * 2048;
  const add = (t, offset, length, kind) => {
    if (t >= duration * 1000) return;
    loads.push({ t: Math.round(t), offset, length: Math.min(length, size - offset), kind });
  };
  add(0, 0, 0x8010, "header");
  add(200, 0x2440, 0x30000, "apploader");
  add(400, Math.floor(size * 0.0004 / 2048) * 2048, 1 << 20, "fst");
  add(700, anywhere(4 << 20), 4 << 20, "dol");
  let last = 0;
  for (let i = 0; i < 6; i++) {
    const length = small();
    last = anywhere(length);
    add(1500 + i * 500, last, length, "boot");
  }
  for (let t = 8000; t < duration * 1000; t += between(4000, 10000)) {
    const files = 1 + Math.floor(rnd() * 2);
    for (let i = 0; i < files; i++) {
      const length = small();
      const offset = rnd() < 0.33 ? Math.min(size - length, last + 2048 * Math.floor(between(1, 64))) : anywhere(length);
      add(t + i * 200, offset, length, "menu");
      last = offset + length;
    }
  }
  return loads.sort((a, b) => a.t - b.t);
}

// ── the old reader, as dolphin-browser's patch 0001 had it ─────────────────────────
const OLD_READER_SOURCE = `
const RANGE_BLOCK_OLD = 4 * 1024 * 1024;
const RANGE_CACHE_BLOCKS_OLD = 64;
class OldRangeDisc {
  constructor({ url, name, size }) {
    this.url = url; this.name = name; this.size = size; this.type = "application/octet-stream";
    this.blocks = new Map(); this.prefetching = new Set();
    this.stats = { requests: 0, bytes: 0, waits: 0, waitMs: 0 };
  }
  slice(start = 0, end = this.size) {
    start = Math.max(0, Math.min(start, this.size)); end = Math.max(start, Math.min(end, this.size));
    const out = new Uint8Array(end - start);
    let pos = start, off = 0;
    while (pos < end) {
      const i = Math.floor(pos / RANGE_BLOCK_OLD), b = this.block(i);
      const from = pos - i * RANGE_BLOCK_OLD, n = Math.min(b.length - from, end - pos);
      out.set(b.subarray(from, from + n), off); pos += n; off += n;
    }
    return { size: out.length, buffer: out.buffer };
  }
  block(i) {
    let b = this.blocks.get(i);
    if (b) { this.blocks.delete(i); this.blocks.set(i, b); }
    else { b = this.fetchSync(i); this.keep(i, b); }
    const next = i + 1;
    if (next * RANGE_BLOCK_OLD < this.size && !this.blocks.has(next) && !this.prefetching.has(next)) this.prefetch(next);
    return b;
  }
  keep(i, b) {
    this.blocks.set(i, b);
    while (this.blocks.size > RANGE_CACHE_BLOCKS_OLD) this.blocks.delete(this.blocks.keys().next().value);
  }
  range(i) { const a = i * RANGE_BLOCK_OLD; return [a, Math.min(a + RANGE_BLOCK_OLD, this.size) - 1]; }
  fetchSync(i) {
    const [a, b] = this.range(i), t0 = performance.now();
    const x = new XMLHttpRequest();
    x.open("GET", this.url, false); x.responseType = "arraybuffer";
    x.setRequestHeader("Range", \`bytes=\${a}-\${b}\`); x.send();
    if (x.status !== 206) throw new Error(x.status === 200 ? "the server ignored the Range request" : \`disc read failed: HTTP \${x.status}\`);
    const bytes = new Uint8Array(x.response);
    if (bytes.length !== b - a + 1) throw new Error(\`short disc read (\${bytes.length} of \${b - a + 1})\`);
    this.stats.requests++; this.stats.bytes += bytes.length; this.stats.waits++; this.stats.waitMs += performance.now() - t0;
    return bytes;
  }
  prefetch(i) {
    const [a, b] = this.range(i);
    this.prefetching.add(i);
    fetch(this.url, { headers: { Range: \`bytes=\${a}-\${b}\` }, credentials: "same-origin", cache: "no-store" })
      .then(async (r) => {
        if (r.status !== 206) return;
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (bytes.length === b - a + 1 && !this.blocks.has(i)) { this.keep(i, bytes); this.stats.requests++; this.stats.bytes += bytes.length; }
      })
      .catch(() => {})
      .finally(() => this.prefetching.delete(i));
  }
}
`;

const WORKER_SOURCE = `
import { openRangeDisc } from "/src/remote-disc.js";
import { createDiscFetcher } from "/src/remote-disc-fetch.js";
${PATTERN_SOURCE}
${OLD_READER_SOURCE}
const SLICE = ${SLICE};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const channel = new MessageChannel();
const yieldQueue = [];
channel.port1.onmessage = () => yieldQueue.shift()?.();
const yieldTask = () => new Promise((resolve) => { yieldQueue.push(resolve); channel.port2.postMessage(0); });
const log = (message) => console.log("[disc] " + message);

self.onmessage = async ({ data }) => {
  try {
    self.postMessage({ ok: true, result: await run(data) });
  } catch (error) {
    self.postMessage({ ok: false, error: String(error?.stack || error) });
  }
};

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

async function run(cfg) {
  const pattern = makePattern(cfg.seed);
  const head = await fetch(cfg.url, { method: "HEAD", cache: "no-store" });
  const source = {
    url: new URL(cfg.url, self.location.href).href,
    name: "synthetic.img",
    size: Number(head.headers.get("Content-Length")),
    etag: head.headers.get("ETag"),
    lastModified: head.headers.get("Last-Modified")
  };
  const tOpen = performance.now();
  const disc = cfg.reader === "before"
    ? new OldRangeDisc(source)
    : await openRangeDisc(source, {
        opfs: cfg.opfs,
        prefetch: cfg.prefetch,
        getRoot: () => navigator.storage.getDirectory(),
        estimate: () => navigator.storage.estimate(),
        createFetcher: (s, o) => createDiscFetcher(s, { ...o, log }),
        log
      });
  const openMs = performance.now() - tOpen;
  const tiered = cfg.reader !== "before";
  const waitsOf = () => (tiered ? disc.waits : disc.stats.waits);
  let downloadMs = null;
  if (tiered && cfg.downloadFirst && disc.stats.mode === "cached" && !disc.stats.complete) {
    const t = performance.now();
    while (!disc.stats.complete && disc.stats.mode === "cached") await sleep(250);
    downloadMs = performance.now() - t;
  }
  const atStart = tiered ? disc.stats : { ...disc.stats };
  if (tiered) disc.setGameRunning(true);

  const start = performance.now();
  const lags = [];
  let expected = start + 10;
  let ticking = true;
  const tick = () => {
    const now = performance.now();
    lags.push([now - start, Math.max(0, now - expected)]);
    expected = now + 10;
    if (ticking) setTimeout(tick, 10);
  };
  setTimeout(tick, 10);
  let completeAt = tiered && disc.stats.complete ? 0 : null;
  const progress = [];
  const poll = setInterval(() => {
    const s = disc.stats;
    const t = (performance.now() - start) / 1000;
    if (tiered) progress.push([Math.round(t), s.storedBytes, s.bytes]);
    if (tiered && completeAt == null && s.complete) completeAt = t;
  }, 1000);

  const slices = [];
  let bad = 0;
  let readBytes = 0;
  for (const load of cfg.trace) {
    const ahead = start + load.t - performance.now();
    if (ahead > 0) await sleep(ahead);
    for (let pos = load.offset; pos < load.offset + load.length; pos += SLICE) {
      const end = Math.min(pos + SLICE, load.offset + load.length);
      const before = waitsOf();
      const t = performance.now();
      const { buffer } = disc.slice(pos, end);
      const dt = performance.now() - t;
      slices.push([t - start, dt, waitsOf() - before]);
      const got = new Uint8Array(buffer);
      const want = fillDisc(pattern, new Uint8Array(64), pos);
      for (let i = 0; i < 64 && i < got.length; i++) if (got[i] !== want[i]) { bad++; break; }
      const tail = Math.max(0, got.length - 64);
      const wantTail = fillDisc(pattern, new Uint8Array(got.length - tail), pos + tail);
      for (let i = 0; i < wantTail.length; i++) if (got[tail + i] !== wantTail[i]) { bad++; break; }
      readBytes += end - pos;
      await yieldTask();
    }
  }
  const traceEnd = performance.now() - start;
  // Let the clock run out the session, so the download's progress is seen to the end.
  const rest = cfg.duration * 1000 - (performance.now() - start);
  if (rest > 0) await sleep(rest);
  ticking = false;
  clearInterval(poll);
  const stats = disc.stats;
  if (tiered) {
    disc.flush();
    await disc.close();
  }
  const after = (ms) => slices.filter(([t]) => t >= ms);
  const waited = (list) => list.filter(([, , w]) => w > 0);
  const sumMs = (list) => list.reduce((a, [, dt]) => a + dt, 0);
  const lagValues = lags.map(([, lag]) => lag);
  const lagAfter = lags.filter(([t]) => t >= 90000).map(([, lag]) => lag);
  // Lag not explained by a wait: a tick whose late stretch overlaps no waiting read is
  // the reading thread busy with something else (here: writing blocks to this device).
  const waits = waited(slices).map(([t, dt]) => [t, t + dt]);
  const busy = lags.filter(([t, lag]) => !waits.some(([a, b]) => t - lag <= b && t >= a)).map(([, lag]) => lag);
  return {
    openMs: Math.round(openMs),
    downloadMs: downloadMs == null ? null : Math.round(downloadMs),
    traceEndMs: Math.round(traceEnd),
    readBytes,
    slices: slices.length,
    badSlices: bad,
    waits: waited(slices).length,
    waitMs: Math.round(sumMs(waited(slices))),
    waitsAfter90: waited(after(90000)).length,
    waitMsAfter90: Math.round(sumMs(waited(after(90000)))),
    maxReadMs: Math.round(Math.max(0, ...slices.map(([, dt]) => dt))),
    maxReadMsAfter90: Math.round(Math.max(0, ...after(90000).map(([, dt]) => dt))),
    waitTimes: waited(slices).map(([t, dt]) => [Math.round(t), Math.round(dt)]),
    waitP50: Math.round(percentile(waited(slices).map(([, dt]) => dt), 0.5)),
    waitP90: Math.round(percentile(waited(slices).map(([, dt]) => dt), 0.9)),
    lagP50: +percentile(lagValues, 0.5).toFixed(2),
    lagP99: +percentile(lagValues, 0.99).toFixed(2),
    lagMax: Math.round(Math.max(0, ...lagValues)),
    lagP99After90: +percentile(lagAfter, 0.99).toFixed(2),
    lagMaxAfter90: Math.round(Math.max(0, ...lagAfter)),
    busyLagP99: +percentile(busy, 0.99).toFixed(2),
    busyLagMax: Math.round(Math.max(0, ...busy)),
    busyTicksOver8: busy.filter((lag) => lag > 8).length,
    ticks: lags.length,
    completeAt,
    progress,
    atStart: { storedBytes: atStart.storedBytes ?? 0, mode: atStart.mode ?? "memory" },
    stats
  };
}
`;

const PAGE_SOURCE = `<!doctype html><meta charset="utf-8"><title>remote disc bench</title>
<script type="module">
const worker = new Worker("/__bench/worker.js", { type: "module" });
worker.onmessage = (event) => { window.__result = event.data; };
worker.onerror = (event) => { window.__result = { ok: false, error: event.message || "worker error" }; };
window.__run = (cfg) => worker.postMessage(cfg);
window.__ready = self.crossOriginIsolated;
</script>`;

// ── the server: the repo's src/, the bench page, and the throttled disc ─────────────
const served = { bytes: 0, requests: 0 };
let nextFree = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MIME = { ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html" };

function startServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://bench");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Cache-Control", "no-store");
    if (url.pathname === "/__bench/page") {
      res.setHeader("Content-Type", "text/html");
      return res.end(PAGE_SOURCE);
    }
    if (url.pathname === "/__bench/worker.js") {
      res.setHeader("Content-Type", "text/javascript");
      return res.end(WORKER_SOURCE);
    }
    if (url.pathname === "/disc/synthetic.img") return serveDisc(req, res);
    const file = path.join(root, path.normalize(url.pathname));
    if (!file.startsWith(path.join(root, "src") + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404);
      return res.end();
    }
    res.setHeader("Content-Type", MIME[path.extname(file)] ?? "application/octet-stream");
    return res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(options.port, "127.0.0.1", () => resolve(server)));
}

async function serveDisc(req, res) {
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("ETag", ETAG);
  res.setHeader("Last-Modified", LAST_MODIFIED);
  res.setHeader("Content-Type", "application/octet-stream");
  if (req.method === "HEAD") {
    res.setHeader("Content-Length", SIZE);
    res.writeHead(200);
    return res.end();
  }
  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
  let a = 0;
  let b = SIZE - 1;
  if (m) {
    a = Number(m[1]);
    b = m[2] ? Math.min(Number(m[2]), SIZE - 1) : SIZE - 1;
    if (a > b) {
      res.writeHead(416);
      return res.end();
    }
    res.setHeader("Content-Range", `bytes ${a}-${b}/${SIZE}`);
  }
  res.setHeader("Content-Length", b - a + 1);
  res.writeHead(m ? 206 : 200);
  served.requests += 1;
  let closed = false;
  res.on("close", () => { closed = true; });
  if (options.delayMs) await sleep(options.delayMs);
  const rate = options.bwMbit * 125000;              // bytes per second
  const t0 = Date.now();
  let own = 0;
  const chunk = Buffer.alloc(64 * 1024);
  for (let pos = a; pos <= b && !closed;) {
    const n = Math.min(chunk.length, b - pos + 1);
    if (rate) {
      if (options.perRequestBw) {
        const wait = ((own + n) / rate) * 1000 - (Date.now() - t0 - options.delayMs);
        if (wait > 0) await sleep(wait);
      } else {
        const now = Date.now();
        const at = Math.max(now, nextFree);
        nextFree = at + (n / rate) * 1000;
        if (nextFree - now > 1) await sleep(nextFree - now);
      }
    }
    if (closed) break;
    const view = chunk.subarray(0, n);
    fillDisc(PATTERN, view, pos);
    served.bytes += n;
    own += n;
    pos += n;
    if (!res.write(Buffer.from(view))) await new Promise((resolve) => res.once("drain", resolve));
  }
  res.end();
}

async function loadPlaywright() {
  const local = path.join(root, ".omx", "browser-probe", "node_modules", "playwright", "index.mjs");
  if (existsSync(local)) return import(pathToFileURL(local).href);
  try {
    return await import("playwright");
  } catch {
    return createRequire(import.meta.url)("playwright");
  }
}

const SCENARIOS = {
  before: { reader: "before", label: "before: memory + sync XHR (dolphin-browser 0001)", profile: "fresh" },
  noopfs: { reader: "tiered", opfs: false, prefetch: true, label: "tiered, ?opfs=0 (memory + fetch worker)", profile: "fresh" },
  noprefetch: { reader: "tiered", opfs: true, prefetch: false, label: "tiered, ?prefetch=0 (no sequential stream)", profile: "fresh" },
  first: { reader: "tiered", opfs: true, prefetch: true, label: "tiered, first launch", profile: "fresh", keep: "tiered" },
  second: { reader: "tiered", opfs: true, prefetch: true, label: "tiered, second launch (same profile)", profile: "tiered" },
  downloadfirst: { reader: "tiered", opfs: true, prefetch: true, downloadFirst: true, label: "tiered, download fully before starting", profile: "fresh" }
};

async function runScenario(playwright, name, trace) {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`unknown scenario ${name}`);
  const profileDir = path.join(options.out, "profiles", scenario.profile === "fresh" ? `fresh-${name}` : scenario.profile);
  if (scenario.profile === "fresh") rmSync(profileDir, { recursive: true, force: true });
  if (scenario.keep) {
    const keep = path.join(options.out, "profiles", scenario.keep);
    rmSync(keep, { recursive: true, force: true });
  }
  const dir = scenario.keep ? path.join(options.out, "profiles", scenario.keep) : profileDir;
  mkdirSync(dir, { recursive: true });
  const context = await playwright.chromium.launchPersistentContext(dir, { headless: !options.headed });
  const page = await context.newPage();
  const consoleLines = [];
  page.on("console", (m) => consoleLines.push(m.text()));
  page.on("worker", (w) => w.on("console", (m) => consoleLines.push(`[worker] ${m.text()}`)));
  served.bytes = 0;
  served.requests = 0;
  nextFree = 0;
  try {
    await page.goto(`http://127.0.0.1:${options.port}/__bench/page`);
    await page.waitForFunction(() => window.__ready !== undefined);
    if (!(await page.evaluate(() => window.__ready))) throw new Error("the bench page is not cross-origin isolated");
    await page.evaluate((cfg) => window.__run(cfg), {
      ...scenario,
      url: "/disc/synthetic.img",
      seed: options.seed,
      duration: options.duration,
      trace
    });
    await page.waitForFunction(() => window.__result, null, { timeout: (options.duration + 900) * 1000, polling: 1000 });
    const outcome = await page.evaluate(() => window.__result);
    if (!outcome.ok) throw new Error(outcome.error);
    return { name, label: scenario.label, ...outcome.result, server: { ...served }, console: consoleLines.filter((l) => /\[disc\]/.test(l)).slice(-20) };
  } finally {
    await context.close();
  }
}

function mb(bytes) {
  return (bytes / 1e6).toFixed(bytes >= 1e8 ? 0 : 1);
}

function table(results) {
  const rows = [
    "| scenario | waits (all) | waited (all) | per wait: median / p90 | waits after 90 s | waited after 90 s | longest read | network MB (server) | timer lag outside waits: p99 / max / ticks > 8 ms | on device at end | whole disc by |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"
  ];
  for (const r of results) {
    const device = r.stats?.mode === "cached" ? `${mb(r.stats.storedBytes)} MB` : (r.stats?.mode ?? "memory only");
    rows.push(`| ${r.label} | ${r.waits} | ${(r.waitMs / 1000).toFixed(1)} s | ${r.waitP50} / ${r.waitP90} ms | ${r.waitsAfter90} | ${(r.waitMsAfter90 / 1000).toFixed(1)} s | ${r.maxReadMs} ms | ${mb(r.server.bytes)} | ${r.busyLagP99} / ${r.busyLagMax} ms / ${r.busyTicksOver8} of ${r.ticks} | ${device} | ${r.completeAt == null ? "-" : `${Math.round(r.completeAt)} s`}${r.downloadMs != null ? ` (+${Math.round(r.downloadMs / 1000)} s before start)` : ""} |`);
  }
  return rows.join("\n");
}

const trace = makeTrace({ size: SIZE, duration: options.duration, seed: options.seed, kind: options.trace });
const traceBytes = trace.reduce((a, l) => a + l.length, 0);
mkdirSync(options.out, { recursive: true });
const server = await startServer();
const playwright = await loadPlaywright();
const link = options.bwMbit ? `${options.bwMbit} Mbit/s ${options.perRequestBw ? "per request" : "shared"}` : "unlimited";
console.log(`disc ${mb(SIZE)} MB, ${options.delayMs} ms first byte, ${link}; ${options.trace} trace ${trace.length} loads, ${mb(traceBytes)} MB over ${options.duration} s`);
const results = [];
for (const name of options.scenarios) {
  const t = Date.now();
  const result = await runScenario(playwright, name, trace);
  results.push(result);
  const busy = result.stats?.busy ? ` · discio worker busy ${JSON.stringify(result.stats.busy)} · fetch worker ${JSON.stringify(result.stats.fetchWorkerBusy)} · writer ${result.stats.writer}` : "";
  const d = result.stats?.demand;
  const demand = d ? ` · demand: ${d.progressWaits} of the waits on a block already arriving (${(d.progressMs / 1000).toFixed(1)} s), ${d.blocks} blocks whole in ${d.blocks ? Math.round(d.blockMs / d.blocks) : 0} ms each, ${d.windowFirst} window-first, ${d.restarts} restarts` : "";
  const link = result.stats?.link ? ` · link ${result.stats.link.mbit} Mbit/s, first bytes ${result.stats.link.rttMs} ms (min ${result.stats.link.rttMinMs})` : "";
  console.log(`${name}: waits ${result.waits} (${(result.waitMs / 1000).toFixed(1)} s), after 90 s ${result.waitsAfter90} (${(result.waitMsAfter90 / 1000).toFixed(1)} s), network ${mb(result.server.bytes)} MB, bad ${result.badSlices}, ${Math.round((Date.now() - t) / 1000)} s${busy}${demand}${link}`);
}
server.close();
const summary = { options: { ...options, size: SIZE, link, traceLoads: trace.length, traceBytes }, results };
const stamp = `${options.trace}-${options.delayMs}ms-${options.bwMbit || "unlimited"}${options.perRequestBw ? "-perreq" : ""}`;
writeFileSync(path.join(options.out, `bench-${stamp}.json`), JSON.stringify(summary, null, 1));
writeFileSync(path.join(options.out, `bench-${stamp}.md`), `${link}, ${options.delayMs} ms first byte, ${mb(SIZE)} MB disc, ${options.trace} trace (${trace.length} loads, ${mb(traceBytes)} MB), ${options.duration} s session\n\n${table(results)}\n`);
console.log(`\n${table(results)}\n\nwritten to ${options.out}`);
if (results.some((r) => r.badSlices)) process.exitCode = 1;
