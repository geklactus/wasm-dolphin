# Discs on a server (`?disc=`)

`?disc=<same-origin URL>` plays a disc image that stays on the server. The page
needs only its size and validators (one `HEAD`) and its header (for the game
id); the discio worker reads the rest a block at a time and, while the game
runs, pulls the whole image onto this device, so that after the first minutes
nothing waits on the network and a second launch reads nothing from it.

The server must answer Range requests (`206`) on the same origin as the page.
`npm start` does (`tools/serve.mjs` sends `Accept-Ranges`, `ETag` and
`Last-Modified`): put an image under the checkout and open
`http://127.0.0.1:8080/?disc=/discs/game.rvz`. A click starts it (the
AudioContext needs a gesture), so the screen becomes a start button.

## The tiers

WORKERFS reads a mounted file with `contents.slice(a, b)`, synchronously, from
the core's proxied syscalls. `RangeDisc` (`src/remote-disc.js`) stands in for
the dropped `File` and serves each slice from:

| | where | what |
|---|---|---|
| L1 | memory | the last 64 blocks (4 MiB each, 256 MiB), as before |
| L2 | this device | the whole image in the origin-private file system, one file per disc, read through a `FileSystemSyncAccessHandle` |
| L3 | the network | HTTP Range requests, all made by a fetch worker |

A read checks L1, then L2, then waits on L3 — for the bytes it needs, not their
whole block (see [A miss waits for its window](#a-miss-waits-for-its-window-not-its-block)).
Every block that arrives whole from L3 is written to L2 (and a miss's block, as
before, kept in L1); L1 and L2 only ever hold whole blocks. L2 reads take exactly
the bytes asked for, not whole blocks.

**Who writes the copy.** In Chromium (shared sync handles, `mode:
"readwrite-unsafe"`, since 121) the fetch worker writes every block, flushes, and
keeps the bitmap and metadata files; the discio worker holds a second, shared
handle on the image and only reads. A Web Lock per disc keeps a second tab off the
copy (shared handles alone would let it in). Writing a 4 MiB block into the sparse
image cost 24 ms in this project's Linux container (block allocation), and a flush
after 5 s of writes 55 ms — time the discio worker, which also serves the core's
other syscalls and presents frames, should not spend: with the writes in the
discio worker, its 10 ms timer ran more than 8 ms late on 262 of 18,913 ticks
during a first launch; with them in the fetch worker, on 2 of 10,745. Where shared
handles don't exist, the discio worker opens the copy with an exclusive handle and
writes it itself (blocks handed over from the fetch worker's slots).

On disk, a disc is three files under `dolphin-discs/` in OPFS, named by a hash
of its URL:

- `<key>.img` — the image, at its own offsets. It is sized to the full image up
  front (sparse), so its size proves nothing.
- `<key>.map` — the bitmap, one bit per block. **The bitmap is the only record
  of what is present.** A block's bit reaches this file only after the image has
  been flushed, so a crash can lose progress but never mark a block that isn't
  there.
- `<key>.json` — what the copy is of (URL, size, `ETag`, `Last-Modified`, block
  size) and a progress figure for the listing.

## The sequential stream and the park rule

The fetch worker (`src/remote-disc-fetch.js`, `src/remote-disc-fetch-worker.js`)
pulls the image in order into L2, skipping blocks already there, at most **two
requests in flight**. A miss always goes first:

1. The discio worker takes the block from a finished background slot if one has
   it (no wait), else posts `{demand, block, from, len}` — the part of the core's
   read that falls in that block, its *window* — and blocks on a shared word
   (`Atomics.wait`).
2. The fetch worker aborts every other request — each keeps the bytes it got,
   and a later request resumes after them — continues the block if it was
   already on its way (no second request), or starts it, and answers as soon as
   the window has arrived.
3. The rest of the block keeps the link to itself. Once it is whole, the fetch
   worker resumes: one block ahead of the miss first (as the old reader did),
   then the sequential stream.

**Why a second worker.** A miss has to be answered synchronously, so the discio
worker blocks. An abort issued from the blocked thread only reaches the network
once its event loop turns. Measured in Chromium on a shared 100 Mbit/s link with
40 ms to first byte, a 4 MiB miss beside two streaming requests took 1.09 s when
the discio worker aborted them first, 1.11 s when it didn't, and 0.43 s alone;
aborted from a separate worker it took 0.43 s. So every request is made by the
fetch worker, whose loop stays free.

The two workers share one `SharedArrayBuffer`: the demand word
(`sequence << 2 | state`, answered with a compare-and-swap so a late answer to an
abandoned miss is never taken for the current one) and what the answer is, a small
slot table, counters, the L2 bitmap (written only by the writer of the copy), and
the slots' data (one block each: where a miss starts, two in flight, two finished
and not yet taken).

While the game runs, the stream is held to 32 MiB/s (about 270 Mbit/s), so a fast
LAN does not turn the download into a disc- and CPU-bound job beside the game (and,
in the fallback, the discio worker into a disc writer). Before the boot ("Download
fully before starting") it is unlimited. Misses and the block ahead are never held
back.

Without `SharedArrayBuffer` or nested workers, the reader falls back to the old
behaviour (synchronous XHR per miss, one block ahead) with no sequential stream.
There a miss still waits for its whole block.

## A miss waits for its window, not its block

A block is 4 MiB, because that is the unit of the copy on this device (its bitmap
and `DISC_META_VERSION` are unchanged, so copies made before stay valid). The core
usually needs much less of it: a slice of tens to hundreds of KiB. Waiting for the
whole block cost about 1.5 s per miss at 20 Mbit/s where the slice alone is a
round trip and 0.05–0.2 s of transfer; on the home server, whose library is on a
USB disk, a 4 MiB range takes 110–310 ms to read where its first bytes come in
about 10 ms. So the fetch worker answers a miss on progress:

- **The window first.** A window in the block's first 64 KiB is fetched from the
  start of the block, to its end. A window further in is fetched from its start
  (aligned down to 64 KiB) to the end of the block first, then the start of the
  block. Once the block is whole, the block after it and the stream follow, as
  before.
- **Answered as it lands.** Each chunk of the response is checked against the
  window of the read that is waiting; when the window is in the slot, the fetch
  worker answers and the discio worker copies just those bytes out, while the rest
  of the block goes on arriving into the same slot. The fetch worker never writes
  over bytes that have arrived, and never gives the slot to another block while
  the demand word says the discio worker is copying from it.
- **A later read into the same block** goes back to the fetch worker, which
  answers from the same slot: at once if its window is already there, else when
  the request in flight brings it — never a second request for bytes already on
  their way. If the window is further ahead of that request than 256 KiB (or a
  round trip's worth of bytes, if more), the request restarts at the window,
  keeping what it got, and what it skipped comes after.
- **Out of order.** Each slot keeps the ranges of its block that have arrived, not
  a high-water mark. A block parked mid-way (a read elsewhere, or the stream
  stepping aside for the block ahead) keeps them, and whatever takes the block up
  again — a read, the block ahead, the sequential stream — fetches only its gaps
  (counted in `salvagedBytes`). A read whose window is in a parked block is
  answered from it at once, and the rest resumes at the read's priority.
- **L1 keeps a block out until it is whole.** A block still arriving is in exactly
  one place, the fetch worker's slot; L1 and L2 only ever hold whole blocks, so
  neither needs to know about partial ones, and a read is never served from a
  half-filled entry. The cost is that a read into a block still arriving takes a
  message to the fetch worker (well under a millisecond) instead of a lookup.
  Once whole, the block is offered to the discio worker like a finished
  background block and goes into L1; with `?opfs=0` that is where every block a
  read waited on ends up.
- **L2 only ever gets whole blocks**, written after their last byte — by the
  fetch worker where it writes the copy, by the discio worker (from the offered
  block) where it does — and a block's bit is set only after it is written.

What counts as a wait changes with this: a read of a 1 MiB file at 20 Mbit/s used
to be one wait of ~1.8 s (its 4 MiB block), and is now a short wait for its first
slice and then several of ~0.05 s each on the block's progress (the core reads
faster than the link). `waits` counts every read that waited; `demand.progressWaits`
says how many of them were on a block already arriving. Compare total wait time
first, and time per wait with that split in mind.

Measured with `tools/remote-disc-bench.mjs --trace menus` (a model of a cold boot
into a title's menus: small files at random offsets, read in 128 KiB slices, on a
generated 2.8 GB disc; two sessions each), `main` against this:

| link | | waited in 105 s | first wait on a block | waits on a block's progress | longest read |
|---|---|---:|---:|---:|---:|
| 20 Mbit/s, 90 ms to first byte | before | 39.6–43.9 s (22–23 waits) | 1.80–1.91 s | — | 1.8–3.6 s |
| | after | 6.1–7.7 s (73–95 waits) | 0.15–0.16 s | ~0.05 s | 0.18–0.27 s |
| 100 Mbit/s, 40 ms | before | 7.1–9.8 s (16–23 waits) | 0.41–0.44 s | — | 0.4–0.8 s |
| | after | 1.5–2.1 s (62–86 waits) | 0.06 s | ~0.01 s | 0.06–0.11 s |

The same with `?opfs=0` and with the defaults, within a few percent. A cold stall
at 20 Mbit/s is now a round trip plus a slice, under the 0.5 s below which
splitting a demand into smaller requests was to be considered, so a demand is still
one request from the window to the end of the block. Details, and what was not
measured (the real core, Mario Kart Wii, a real cellular link), in
[the results](perf-results/remote-disc-window-2026-10-24.md).

## The read order (`<disc file>.reads.json`)

The sequential stream pulls the image from its first block to its last, so on a
first launch it can be fetching the end of the disc while the game wants the
middle, and each block the game reaches first is a miss. A **read order** puts
the blocks a title reads first at the front of the stream.

- **Recording.** With `?recordreads=1` the reader notes each block the core
  reads, the first time it reads it, with the seconds since the disc was opened.
  *Save read order* (in the Game block, shown only with the flag) downloads it as
  `<GAMEID>.reads.json`; `window.__discReadOrder()` returns the same object for
  harnesses (`tools/probe.mjs --record` in dolphin-browser saves one from a
  scripted session). It is `{ v, game, name, size, block, blocks, seconds }`:
  block numbers and times, nothing of the game.
- **Use.** Kept beside the disc as `<disc file>.reads.json` (for
  `mkw.rvz`, `mkw.rvz.reads.json`), it is fetched once when the disc opens, not
  waited for. The fetch worker's sequential stream then takes its blocks in its
  order, skipping any already here, and the rest from the start as before.
  Misses and the block ahead still go first. A 404 is the normal case and changes
  nothing; a file made for another image (another size or block size) is ignored
  and logged.
- **Only with this device's copy.** The order steers the sequential stream, and
  there is none with `?opfs=0` or `?prefetch=0` (the log says so). In those modes
  a read order has no effect.

Measured with Mario Kart Wii (`mkw.rvz`, 672 blocks) on a shared 100 Mbit/s link
with 40 ms to first byte, two cold launches each (a fresh browser profile, so
nothing on this device), dolphin-browser's `tools/probe.mjs` driving the same
session (boot, then A now and then, into the title's menus); the order was
recorded once from that session at full speed (39 blocks).
In the first 90 s:

| | waits | wait time |
|---|---|---|
| no read order | 14, 14 | 5.33 s, 5.27 s |
| with `mkw.rvz.reads.json` | 3, 3 | 1.16 s, 1.15 s |
| `?opfs=0`, no read order | 18, 19 | 6.75 s, 7.50 s |
| `?opfs=0`, with it (not used) | 17, 17 | 6.63 s, 6.72 s |

With the copy on this device, game speed was the same (median 100–101 %) and the
network bytes within 3 %.

## Invalidation, eviction, space

- **The source changed** (size, `ETag` or `Last-Modified` differ from the
  copy's, or a server that sent one stops): the copy is discarded and starts
  over. Each Range response is also checked (`Content-Range` total, `ETag`,
  `Last-Modified`); a mismatch mid-session drops the copy, the game keeps
  streaming, and the panel says to reload.
- **Eviction** (any file missing, the image the wrong size, unreadable
  metadata): start over, never a crash. A read from L2 that fails or comes back
  short drops to streaming for the session.
- **Space**: `navigator.storage.estimate()` is checked before a copy is
  started; if the image won't fit, the disc streams and the panel says why. A
  backend that refuses the size (Chromium's in-memory one in incognito silently
  leaves the file empty) is caught the same way.
- **Another tab** with the same disc open holds its Web Lock (or, in the fallback,
  the exclusive handle); the second tab streams and says so.
- `navigator.storage.persist()` is asked once, on the first Start.

## The page

The **Game** block shows *On this device: 1.2 GB of 1.4 GB · 11.8 MB/s* (or *all
of it*, or *Streaming only:* and why), then *123 MB from the network · waited 13×
(2.9 s, last 0.21 s) · link 18 Mbit/s, 95 ms* (the link part once the fetch worker
has an estimate), a **Download fully before starting** switch (the boot waits for
the bitmap to be complete; a click starts at once and the download carries on),
and **Remove from this device**. **Settings** lists *Discs on this device* with
their sizes, each removable. `window.__discStats` carries the worker's numbers
for harnesses.

### `__discStats` for tuning

Besides the counts it always had (`requests`, `bytes`, `waits`, `waitMs`, `l1Hits`,
`l2Hits`, `readyHits`, `salvagedBytes`, `aborts`, …):

| field | what |
|---|---|
| `fillingHits` | reads answered from a block still arriving, without waiting |
| `demand.waits`, `demand.windowMs`, `demand.lastWindowMs` | reads that waited on the network; how long until their window had arrived (total, the last one) — the stalls themselves, as the discio worker saw them (`waits` and `waitMs` are the same numbers) |
| `demand.progressWaits`, `demand.progressMs` | of those, reads into a block a read before them was already waiting on (they waited on its progress) |
| `demand.blocks`, `demand.blockMs`, `demand.lastBlockMs` | blocks a read waited on, once whole; time from the first read's demand to the whole block (total, the last one), as the fetch worker saw it — including the start of the block fetched after the window |
| `demand.windowFirst` | requests that began at a window ahead of a missing start |
| `demand.restarts` | requests restarted at a later read's window (see above) |
| `link.mbit` | throughput while a response is arriving: bytes over the time from one chunk to the next while any response is arriving, so idle time and the wait for first bytes don't count; it forgets over ~3 s of receiving, and reads 0 until it has seen 200 ms |
| `link.rttMs`, `link.rttMinMs` | time from a request to its first chunk (smoothed, and the shortest seen), taken only from requests that had the link to themselves; it includes the server's own time to first byte and the first chunk's transfer |

`link` is `null` until there is an estimate, and without a fetch worker.

## Flags

| flag | effect |
|---|---|
| `?prefetch=0` | no sequential stream (misses and the block ahead still land on this device) |
| `?opfs=0` | no copy on this device (memory and network only; no sequential stream, since it has nowhere to go) |
| `?recordreads=1` | keep the order the core first reads each block in; *Save read order* downloads it as `<GAMEID>.reads.json` (see above) |

## Measuring

`tools/remote-disc-bench.mjs` runs the reader in a real Chromium worker against
a throttled server (shared link, first-byte delay) with a generated disc and a
model of a game session's reads (`--trace heavy`, `light`, or `menus`), before vs
after, first vs second launch. It measures the reader, not game speed; see the
results for [the tiers](perf-results/remote-disc-tiers-2026-10-24.md) and for
[waiting for the window](perf-results/remote-disc-window-2026-10-24.md).
