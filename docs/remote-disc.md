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

A read checks L1, then L2, then waits on L3. Every block that arrives from L3 is
written to L2 (and a miss's block, as before, kept in L1). L2 reads take exactly
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
   it (no wait), else posts `{demand}` and blocks on a shared word
   (`Atomics.wait`).
2. The fetch worker aborts every other request — each keeps the bytes it got,
   and a later request resumes after them — continues the block if it was
   already on its way (no second request), or starts it, and answers.
3. Then it resumes: one block ahead of the miss first (as the old reader did),
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
abandoned miss is never taken for the current one), a small slot table, counters,
the L2 bitmap (written only by the discio worker), and the slots' data (one block
each: the miss's own, two in flight, two finished and not yet taken).

While the game runs, the stream is held to 32 MiB/s (about 270 Mbit/s), so a fast
LAN does not turn the download into a disc- and CPU-bound job beside the game (and,
in the fallback, the discio worker into a disc writer). Before the boot ("Download
fully before starting") it is unlimited. Misses and the block ahead are never held
back.

Without `SharedArrayBuffer` or nested workers, the reader falls back to the old
behaviour (synchronous XHR per miss, one block ahead) with no sequential stream.

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
of it*, or *Streaming only:* and why), the network bytes and the waits, a
**Download fully before starting** switch (the boot waits for the bitmap to be
complete; a click starts at once and the download carries on), and **Remove from
this device**. **Settings** lists *Discs on this device* with their sizes, each
removable. `window.__discStats` carries the worker's numbers for harnesses.

## Flags

| flag | effect |
|---|---|
| `?prefetch=0` | no sequential stream (misses and the block ahead still land on this device) |
| `?opfs=0` | no copy on this device (memory and network only; no sequential stream, since it has nowhere to go) |
| `?recordreads=1` | keep the order the core first reads each block in; *Save read order* downloads it as `<GAMEID>.reads.json` (see above) |

## Measuring

`tools/remote-disc-bench.mjs` runs the reader in a real Chromium worker against
a throttled server (shared link, first-byte delay) with a generated disc and a
model of a game session's reads, before vs after, first vs second launch. It
measures the reader, not game speed; see
[the results](perf-results/remote-disc-tiers-2026-10-24.md).
