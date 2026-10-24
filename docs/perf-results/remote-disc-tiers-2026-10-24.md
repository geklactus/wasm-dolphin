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

RESULTS_PLACEHOLDER
