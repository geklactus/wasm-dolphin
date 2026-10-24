# Remote disc tiers: before / after (2026-10-24)

What changed: `?disc=` used to read through dolphin-browser's `RangeDisc` (64 × 4 MiB
blocks in memory, a synchronous XHR per miss, one block prefetched). Now it reads
memory → this device's copy in OPFS → HTTP Range via a fetch worker, which also
pulls the whole image onto this device in order, parking whenever a read waits
(see [docs/remote-disc.md](../remote-disc.md)).

## What was measured, and what was not

**Measured:** `tools/remote-disc-bench.mjs` in this container — Linux, headless
Chromium (Playwright's chrome-headless-shell 1243), 4 cores. The reader runs in a
real dedicated worker with real OPFS sync handles, against a local server with a
first-byte delay and a bandwidth cap. Both readers are the real code: the tiered
one is `src/remote-disc*.js` as committed; the old one is dolphin-browser's
`RangeDisc`, embedded verbatim in the tool.

- **The disc is generated** (1.4 GB; every byte a function of its offset, and every
  read is checked — 0 bad reads in every run below).
- **The reads are a model, not a recording.** The "heavy" model reads 500 MB over
  240 s at offsets uniform over the disc: boot, a minute of menus, then a "course"
  every 20–30 s (one 15–45 MB file, several small ones, music streamed at
  256 KiB/s). It is much harsher than a real session — the old reader waited 193
  times on it, against the 13 waits reported for a Skyward Sword session. The
  "light" model keeps the boot and spaces the rest out.
- **The link is shared**: all responses in flight split the bandwidth, as on a real
  link. (dolphin-browser's `tools/serve.mjs` caps each response separately, which
  lets background requests run beside a miss at no cost to it.)
- "Waits" are reads that had to wait on the network; "timer lag outside waits" is
  how late a 10 ms timer ran on the reading thread at moments when no read was
  waiting — the cost of the background work (writing blocks to OPFS) to whatever
  else the discio worker does.

**Not measured here:** game speed, and anything on a Mac or with Mario Kart Wii.
There is no game image in this environment (and none may be added), so the
acceptance run — Mario Kart Wii RVZ at 100 Mbit / 40 ms, first launch, second
launch, game speed median against the old reader on the LAN — still has to be
done on the Mac. The page exposes the numbers it needs as `window.__discStats`
(and in the Game block).

The real core was exercised separately (see the end): the page with `?disc=`
mounts a hand-made 12 MB GameCube image through the new path, downloads it fully
before starting, and reads nothing from the network on the second launch.

## Results

Raw data beside this file (`remote-disc-tiers-2026-10-24-*.json`: every wait's time
and length, download progress each second, the reader's own counters). Reproduce with
`node tools/remote-disc-bench.mjs` and the flags in each heading.

### 100 Mbit/s shared, 40 ms to first byte — heavy model (`--bw-mbit 100 --delay-ms 40`)

| scenario | waits (all) | waited (all) | waits after 90 s | waited after 90 s | longest read | from the network (server) | timer lag outside waits: p99 / max / ticks > 8 ms | on this device at end | whole disc by |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| before: memory + sync XHR | 195 | 137.4 s | 94 | 65.5 s | 1769 ms | 1682 MB | 10.31 / 120 ms / 134 of 9699 | — | — |
| tiered, first launch | 94 | 41.2 s | **1** | **0.4 s** | 859 ms | 1426 MB | 0.64 / 60 ms / 11 of 19381 | 1400 MB | 126 s |
| tiered, second launch (same profile) | **0** | **0.0 s** | 0 | 0.0 s | 47 ms | **0 MB** | 0.62 / 38 ms / 8 of 23285 | 1400 MB | already |
| tiered, `?prefetch=0` | 169 | 72.1 s | 59 | 24.2 s | 865 ms | 822 MB | 0.72 / 45 ms / 9 of 16392 | 818 MB | — |
| tiered, download fully before starting | 0 | 0.0 s | 0 | 0.0 s | 44 ms | 1400 MB | 1.13 / 35 ms / 6 of 23224 | 1400 MB | before start (+115 s) |

The first launch's last waits: a course load at 84–87 s (eight ~0.43 s waits) and one
0.39 s wait at 115.5 s, when 1.33 of 1.4 GB was on the device; none after the copy
completed at 126 s. The old reader paid about 0.7 s per 4 MiB block on every course
load all session long, consistent with its prefetch and its synchronous fetch of the
same block running side by side on the shared link; a tiered miss on a block already
in flight continues that request instead (~0.41 s per block with `?prefetch=0`).
Parked requests keep what they got: in a 100 MB smoke run, 24.6 MB of partial blocks
were resumed rather than fetched again.

### 0 ms, unlimited (server-bound) — heavy model (`--bw-mbit 0 --delay-ms 0`)

| scenario | waits (all) | waited (all) | waits after 90 s | waited after 90 s | longest read | from the network | timer lag outside waits | on this device at end | whole disc by |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| before | 170 | 7.2 s | 66 | 2.8 s | 140 ms | 1577 MB | 3.2 / 98 ms / 154 of 22293 | — | — |
| tiered, first launch | 34 | 1.6 s | 0 | 0.0 s | 98 ms | 1420 MB | 1.02 / 33 ms / 9 of 23108 | 1400 MB | 38 s |
| tiered, second launch | 0 | 0.0 s | 0 | 0.0 s | 9 ms | 0 MB | 0.88 / 46 ms / 12 of 23262 | 1400 MB | already |

No regression for the reader on a fast network: fewer and shorter waits, and the
reading thread is no busier than with the old reader (the download is held to
32 MiB/s while the game runs and is written by the fetch worker).

### 100 Mbit/s shared, 40 ms — light model (`--trace light`)

| scenario | waits (all) | waited (all) | waits after 90 s | waited after 90 s | longest read | from the network | timer lag outside waits | on this device at end | whole disc by |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| before | 39 | 25.4 s | 20 | 13.0 s | 1040 ms | 331 MB | 0.68 / 270 ms / 31 of 20806 | — | — |
| tiered, first launch | 16 | 6.5 s | 0 | 0.0 s | 441 ms | 1405 MB | 0.68 / 43 ms / 8 of 22786 | 1400 MB | 116 s |
| tiered, second launch | 0 | 0.0 s | 0 | 0.0 s | 14 ms | 0 MB | 0.61 / 28 ms / 14 of 23322 | 1400 MB | already |

A light session reads far less than the disc, so the first launch moves more bytes
than before (the whole image, by design; `?prefetch=0` doesn't).

### 100 Mbit/s **per response**, 40 ms — heavy model (`--per-request-bw`)

How dolphin-browser's `tools/serve.mjs` throttles: each response gets the full rate,
so background requests beside a miss cost it nothing.

| scenario | waits (all) | waited (all) | waits after 90 s | waited after 90 s | longest read | from the network | timer lag outside waits | on this device at end | whole disc by |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| before | 194 | 85.1 s | 88 | 38.3 s | 861 ms | 1674 MB | 8.01 / 76 ms / 146 of 14778 | — | — |
| tiered, first launch | 78 | 35.1 s | 0 | 0.0 s | 869 ms | 1413 MB | 0.91 / 99 ms / 27 of 19921 | 1400 MB | 94 s |

### Who writes the copy

The same first launch (heavy, 100 Mbit/s) with the OPFS writes in the discio worker
(the fallback design) and in the fetch worker (what Chromium now runs):

| writer | discio worker time on writes / flushes | timer lag outside waits: ticks > 8 ms | p99 / max |
|---|---:|---:|---:|
| discio worker | 8.7 s / 1.3 s (writes 26 ms each on average, up to 68 ms) | 258–262 of ~10–19k | 18–23 / 70–75 ms |
| fetch worker | 0 / 0 (the fetch worker spent 8.8 s / 1.3 s) | 2–11 of ~11–19k | 0.6–0.7 / 30–60 ms |

The writes are slow here because each one lands in a hole of the sparse image (the
filesystem allocates blocks on first write: 24 ms per 4 MiB measured alone, against
~1 ms to rewrite allocated space). A Mac's SSD will likely be far faster; the design
no longer depends on it.

## The real core

The real page and core, with `?disc=` against a throttled server (8 Mbit/s, 40 ms), on
a hand-made 12 MB GameCube image (a valid header, FST and DOL header; below the core's
16 MiB boot gate, so it mounts but does not boot — no game data exists here):

| launch | what happened |
|---|---|
| first, "Download fully before starting" | badge counted "Downloading 66% · 1.0 MB/s — click to start now"; the core then mounted the disc (`ZRDE01 / GameCube`, title read from the disc) with 0 waits; panel "On this device: 13 MB (all of it)"; Settings listed it |
| second, same profile | server saw one `HEAD` and **0 disc bytes** (the header for the game id came from the copy too); 58 reads from the copy |
| Remove from this device | files gone; panel "Streaming only: removed from this device"; list empty |
| `?opfs=0` | streamed (1 wait, 4.3 s at 8 Mbit/s), panel "Streaming only: turned off (?opfs=0)" |
