# Remote disc: a miss waits for its window, not its block (2026-10-24)

What changed: a read that misses L1 and L2 used to wait for its whole 4 MiB block.
Now the fetch worker answers it once the bytes the read needs (its *window*) have
arrived, fetches a window well into a block first, and lets a later read into the
same block wait on that block's progress (see
[docs/remote-disc.md](../remote-disc.md#a-miss-waits-for-its-window-not-its-block)).

## What was measured, and what was not

**Measured:** `tools/remote-disc-bench.mjs` in this container — Linux, headless
Chromium (Playwright's chrome-headless-shell 1243), 4 cores. The reader runs in a
real dedicated worker with real OPFS sync handles, against a local server with a
first-byte delay per request and a bandwidth cap shared by every response in
flight. *Before* is `main` at 937dcf6 (the same tool, run from a worktree of it);
*after* is this branch.

- **The disc is generated** (2.8 GB, the size of `mkw.rvz`; every byte a function
  of its offset, and every read is checked — 0 bad reads in all 16 runs).
- **The reads are a model, not a recording**: the new `--trace menus` — a boot
  (header, apploader, FST, a 4 MiB DOL, six small files), then 105 s of menus:
  one or two files every 4–10 s, 16 KiB to 1 MiB each (log-uniform, so most are
  under 256 KiB), a third of them right after the previous one, read in 128 KiB
  slices. Two seeds, so two different sessions (31 loads / 13.3 MB and 30 loads /
  9.8 MB); before and after replay the same ones.
- `?opfs=0` is the bench's `noopfs` scenario (no copy on this device, so no
  sequential stream either — the same as `?opfs=0&prefetch=0`); *defaults* is
  `first` (a fresh profile: copy on this device, sequential stream).

**Not measured here:** Mario Kart Wii, the real core, a real cellular link, and
the Mac. There is no game image in this environment (and none may be added). The
acceptance runs (the shaped local server at 20 Mbit/s + 90 ms and 100 Mbit/s +
40 ms, Mario Kart Wii cold, `?opfs=0&prefetch=0` and defaults) still have to be
done on the Mac; `window.__discStats` has what they need (see below).

## Results

Columns: *waits* are reads that waited on the network; *waited* their total; *first
waits on a block* are the waits that started (or took over) a block, *waits on a
block's progress* reads into a block already arriving for an earlier read (the
core reads faster than the link); *demanded blocks whole* is how long a block a
read waited on took to arrive whole (before, that was the wait itself); the link
estimate is the fetch worker's (`__discStats.link`). Before, every wait was a
first wait on a whole block.

### 20 Mbit/s, 90 ms

| scenario | reader | run | waits | waited | per wait (mean / median / p90) | longest read | first waits on a block: n, mean | waits on a block's progress: n, mean | demanded blocks whole: n, mean | link estimate |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `?opfs=0` (no copy, no stream) | before | 1 | 23 | 43.9 s | 1911 / 1826 / 1879 ms | 3632 ms | 23, 1911 ms | — | 23, 1911 ms | — |
| `?opfs=0` (no copy, no stream) | before | 2 | 22 | 40.0 s | 1817 / 1815 / 1836 ms | 1859 ms | 22, 1817 ms | — | 22, 1817 ms | — |
| `?opfs=0` (no copy, no stream) | after | 1 | 95 | 7.6 s | 80 / 53 / 174 ms | 271 ms | 24, 160 ms | 73, 51 ms | 11, 1891 ms | 19.8 Mbit/s, 120 ms |
| `?opfs=0` (no copy, no stream) | after | 2 | 76 | 6.3 s | 83 / 54 / 174 ms | 178 ms | 22, 153 ms | 54, 54 ms | 12, 1893 ms | 19.9 Mbit/s, 121 ms |
| defaults (copy + stream) | before | 1 | 23 | 43.9 s | 1910 / 1835 / 1864 ms | 3648 ms | 23, 1910 ms | — | 23, 1910 ms | — |
| defaults (copy + stream) | before | 2 | 22 | 39.6 s | 1801 / 1805 / 1834 ms | 1838 ms | 22, 1801 ms | — | 22, 1801 ms | — |
| defaults (copy + stream) | after | 1 | 94 | 7.7 s | 82 / 53 / 174 ms | 270 ms | 24, 164 ms | 72, 52 ms | 11, 1891 ms | 19.9 Mbit/s, 120 ms |
| defaults (copy + stream) | after | 2 | 73 | 6.1 s | 83 / 54 / 173 ms | 185 ms | 21, 152 ms | 52, 55 ms | 12, 1884 ms | 19.9 Mbit/s, 120 ms |

### 100 Mbit/s, 40 ms

| scenario | reader | run | waits | waited | per wait (mean / median / p90) | longest read | first waits on a block: n, mean | waits on a block's progress: n, mean | demanded blocks whole: n, mean | link estimate |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `?opfs=0` (no copy, no stream) | before | 1 | 23 | 9.8 s | 426 / 405 / 422 ms | 802 ms | 23, 426 ms | — | 23, 426 ms | — |
| `?opfs=0` (no copy, no stream) | before | 2 | 22 | 8.9 s | 406 / 405 / 413 ms | 415 ms | 22, 406 ms | — | 22, 406 ms | — |
| `?opfs=0` (no copy, no stream) | after | 1 | 86 | 2.1 s | 24 / 11 / 61 ms | 108 ms | 24, 58 ms | 64, 10 ms | 16, 442 ms | 96.2 Mbit/s, 49 ms |
| `?opfs=0` (no copy, no stream) | after | 2 | 65 | 1.7 s | 26 / 11 / 60 ms | 63 ms | 22, 57 ms | 43, 11 ms | 19, 440 ms | 95.9 Mbit/s, 49 ms |
| defaults (copy + stream) | before | 1 | 16 | 7.1 s | 443 / 420 / 449 ms | 828 ms | 16, 443 ms | — | 16, 443 ms | — |
| defaults (copy + stream) | before | 2 | 19 | 7.9 s | 414 / 412 / 434 ms | 440 ms | 19, 414 ms | — | 19, 414 ms | — |
| defaults (copy + stream) | after | 1 | 68 | 1.5 s | 23 / 11 / 62 ms | 107 ms | 17, 58 ms | 53, 10 ms | 12, 438 ms | 98.7 Mbit/s, 49 ms |
| defaults (copy + stream) | after | 2 | 62 | 1.6 s | 26 / 12 / 62 ms | 83 ms | 19, 61 ms | 43, 11 ms | 17, 443 ms | 98.7 Mbit/s, 49 ms |

Per wait, against the target of about a round trip plus the window over the
bandwidth:

- **20 Mbit/s, 90 ms:** a first wait on a block went from **1.8–1.9 s** to
  **0.15–0.16 s** (a 128 KiB slice is 52 ms at 20 Mbit/s, plus the 90 ms delay and
  up to 64 KiB of alignment); the longest read from 1.8–3.6 s to 0.18–0.27 s; total
  waiting from 40–44 s to **6.1–7.7 s**. The waits on a block's progress are
  ~52 ms each — one 128 KiB slice at the link's rate.
- **100 Mbit/s, 40 ms:** a first wait from **0.41–0.44 s** to **0.06 s**; total
  waiting from 7.1–9.8 s to **1.5–2.1 s**.

There are more waits (62–95 against 16–23), because a read of a file larger than
a slice now waits once per slice on the block's progress instead of once for the
block; total and per-first-wait time are the numbers to compare. A block a read
waited on takes as long to arrive whole as before (1.9 s at 20 Mbit/s, 0.44 s at
100 Mbit/s: two round trips when the window came first, and the block's bytes),
but nothing waits on that unless it reads the rest of the block.

Network bytes are about the same or lower (112–153 MB against 135–153 MB with
`?opfs=0`): a block a read waited on is no longer always fetched whole — a read
elsewhere parks it, and with no sequential stream it is finished only if a read
comes back to it.

**Smaller requests on a slow link (step 4 of the plan) were not needed here:** a
cold stall at 20 Mbit/s + 90 ms is 0.15–0.16 s, well under 0.5 s, so the demand
is still one request from the window to the end of the block. If the Mac or a real
cellular link says otherwise, `__discStats.demand.lastWindowMs` against
`link.mbit` and `link.rttMs` shows by how much.

Reproduce (each writes `bench-menus-*.json` and `.md` under `build/`):

```
node tools/remote-disc-bench.mjs --trace menus --duration 105 --size-mb 2800 \
  --bw-mbit 20 --delay-ms 90 --seed 1 --scenarios noopfs,first
node tools/remote-disc-bench.mjs --trace menus --duration 105 --size-mb 2800 \
  --bw-mbit 100 --delay-ms 40 --seed 1 --scenarios noopfs,first
```

(and `--seed 2`; for *before*, the same from a checkout of 937dcf6 with this
branch's `tools/remote-disc-bench.mjs`). Raw data, every wait's time and length
and the reader's counters: `remote-disc-window-2026-10-24-menus-90ms-20.json` and
`-menus-40ms-100.json` beside this file.
