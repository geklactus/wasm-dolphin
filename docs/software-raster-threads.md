# Software raster threads (`swthreads`)

The software-hybrid path presents 60 frames a second but only about 13 of them
are distinct. This note records where the retained profiles say the time goes,
what was changed, why the output is unchanged, and how to compare the two in
Chrome on a Mac.

## What the profiles point at

The repository's own measurements, all from the fixed Melee Kirby-versus-Link
battle on the recommended URL (`video=software`, `fastsw=1`, `cpu=dual`):

| Signal | Value | Source |
| --- | --- | --- |
| Presentation FPS / unique visual FPS | 59.7 / 12.8 | [software-raster phases](perf-results/melee-software-raster-phases-2026-07-10.md) |
| Sampled stale-source ratio | 78% | same |
| Raster traversal, sampled, per triangle call | 5.77 µs | same |
| TEV per pixel (texture sampling included) | 0.46 µs | same |
| TEV pixels per source frame (after the 2×2 skip) | 65,438 | same |
| FIFO backlog continuously non-empty for | 1.9–2.5 s stretches | same |
| CPU-thread self time in `DolphinWeb_OnXfb` | 7.1% | [post-links CPU profile](perf-results/melee-post-links-cpu-profile-2026-09-08.md) |
| GPU-thread self time in `SetCPStatusFromGPU` / futex wait (hardware-WGPU run) | 28.5% / 36.8% | same |

Read together:

- **The GPU thread is the bottleneck, and the pixel loop is most of it.** At
  0.46 µs a TEV pixel and 65k pixels a frame the shading alone is ~30 ms; the
  traversal samples put the whole triangle loop at ~50 ms a frame. One thread
  cannot do that 60 times a second, and the FIFO stays backed up for seconds
  at a time, which is the game stalling on FIFO high-watermark interrupts
  until the rasterizer catches up. The emulated clock keeps running, so the
  speed readout says 100% while the game itself advances at the rasterizer's
  pace. That is the 13 unique frames.
- **The CPU thread is not the unique-frame limit.** JIT dispatch
  (`ExecuteOneBlock`, `RunWasmBlock`) is where its time goes, but it keeps the
  emulated clock at 100%; speeding up the hand-off would not produce more
  frames while the GPU thread is saturated. The 7% in `DolphinWeb_OnXfb` is
  the YUYV→RGBA decode of an XFB that is unchanged 78% of the time; it becomes
  worth removing once the rasterizer produces more distinct frames.
- **`SetCPStatusFromGPU` at 28% is not per-chunk cost.** That function is a
  handful of atomic loads and stores; the share is the GPU loop spinning
  through its payload while it has nothing to do (the loop only parks when
  `GpuMaySleep` arrives, at 1 kHz from the CPU thread) or while a CP
  interrupt is pending. On the software path the GPU thread is busy
  rasterizing, so that spin is not where the frame time goes; the profile that
  measured it was a hardware-WGPU run.

So the lever is the rasterizer, and the machine has idle cores: on the
software path only the CPU thread and the GPU thread are busy.

## What changed

`Source/Core/VideoBackends/Software/Rasterizer.cpp` now queues the triangles
of one draw batch (one `SWVertexLoader::DrawCurrentBatch`) and rasterizes them
at the end of the batch. When the batch's bounding boxes cover enough of the
EFB (4,096 pixels) and worker threads exist, the EFB is split into 22
horizontal bands of 24 rows, and the GPU thread plus the workers claim bands
from a shared counter; each thread draws every queued triangle's rows inside
its band, in queue order. Small batches, and all batches when `swthreads=0`,
are drawn inline on the GPU thread in upstream order.

Workers are started once by `Rasterizer::Init` from
`Module.dolphinSoftwareRasterThreads` (the host resolves `?swthreads=`), and
joined by `Rasterizer::Shutdown`. Between jobs a worker spins for 150 µs and
then parks on a futex; a new job wakes the parked ones. Bands are handed out
dynamically, so a worker that has not been scheduled yet never holds the GPU
thread up.

Supporting changes:

- `Tev` accumulates its pixel statistics and bounding-box extents per batch
  instead of touching `g_stats` and `BBoxManager` per pixel; the rasterizer
  merges them under one lock at the end of each band or batch.
- `EfbInterface::IncPerfCounterQuadCount` counts thread-locally;
  `FlushPerfCounters` folds the counts in at the same merge point.
- `Core.cpp` reads the requested count (`DolphinWeb_SoftwareRasterThreads`) and
  publishes the started count, which `GetVideoStats` carries as `swthreads:N`.

## Why the picture is identical

The claim is byte-identical EFB contents against the single-threaded
rasterizer, not an approximation:

- Within a batch the BP/XF/CP registers are constant: every register write
  flushes pending vertices first (`BPWritten` → `FlushPipeline`,
  `LoadXFReg` → `Flush`), so every queued triangle sees the state the
  sequential code would have seen.
- Each pixel's work reads and writes only its own EFB pixel (`ZCompare`,
  `BlendTev`), and `Tev::Draw` reloads its registers from the pixel-shader
  constants for every pixel. The only neighbour writes are the `fastsw`
  post-pass, which fills the 2×2 or 4×4 cell whose top-left pixel was shaded;
  bands are multiples of 4 rows and the 2×2 raster blocks never straddle one,
  so every EFB row is written by exactly one thread per job.
- Within one band, triangles are drawn in queue order, so the sequence of
  writes to any pixel is the same subsequence as before.
- `zfreeze` is the one cross-triangle dependency. The z slope is updated by
  every triangle (and by culled triangles, through the clipper's
  `UpdateZSlope`) exactly as upstream does it, before the band is applied. With
  `zfreeze` off every triangle uses its own slope; with it on nothing updates
  the slope, so within a batch there is no dependency between triangles. Each
  job starts the workers from the GPU thread's slope and, when the job ends,
  the GPU thread's slope is set to what the last queued triangle leaves,
  which is what the next batch (possibly with `zfreeze` on) needs.
- Statistics, perf-query counters and the bounding box are sums and min/max,
  so merging per band gives the same totals. The one deliberate difference is
  the perf-query "quad" phase counter, which is now per thread; perf queries
  were already an approximation of hardware quads.

Two diagnostic-only differences: the metrics-gated raster traversal counter
counts a tall triangle once per band it touches (each count covering only that
band's rows), and the default-off TEV hot-case shadow latch is copied from the
GPU thread's `Tev` into each worker at the start of a job rather than shared.

## Flags and defaults

| URL | Panel | Meaning |
| --- | --- | --- |
| `swthreads=auto` (default) | Raster threads: Auto | `floor(cores / 2) - 2` workers, capped at 4 (0 on 4 cores, 2 on 8, 3 on 10, 4 from 12) |
| `swthreads=0` | Off (single thread) | Upstream single-threaded rasterizer; the rollback and the A/B baseline |
| `swthreads=N` | 1–4 workers | Exactly `N` workers; the URL accepts up to 8 |

The count applies from boot (**Apply restart**). The worker's status log
prints `Software rasterizer threads: N worker(s) + GPU thread`, and the core's
video stats string (DBG panel, `metrics=1`) ends with `swthreads:N`.

The worker threads come from the core's pre-spawned pthread pool
(`PTHREAD_POOL_SIZE=16`); the CPU, GPU, DVD and timer threads use five or six
of those, so the cap of eight workers always fits.

## How to compare before and after (Chrome on a Mac)

The honest number is distinct frames per second, not the speed readout: with
the rasterizer saturated the speed readout stays near 100% while the game
itself runs at the rasterizer's pace. Use the HUD's **visual** counter, and for
gameplay rate time the in-game clock (Melee's match timer) against a
stopwatch.

1. Check how many cores Chrome sees: in the DevTools console,
   `navigator.hardwareConcurrency`. Auto picks `floor(cores / 2) - 2` workers
   (an 8-core M1/M2 gets 2, a 10-core M-Pro 3, 12 cores or more 4). On an
   8-core machine also try `swthreads=3` and `swthreads=4` by hand; the
   efficiency cores make those a measurement rather than a prediction.
2. Start the dev server from this branch: `npm run play`. Keep one tab open at
   a time, close other heavy apps, stay plugged in.
3. Load the disc and reach the scene you want to measure. Save it with the
   HUD's **Save state** button (one slot) so both arms start from the same
   frame.
4. **Baseline (A):** add `&swthreads=0` to the URL and press **Apply restart**
   (or set *Raster threads: Off* in the panel). Load the save state, wait for
   the status pill to announce the JIT is enabled (the configured warmup), then
   read the HUD for 30–60 s: `visual` (distinct frames per second), `speed`,
   `present`. Note the match-timer seconds that elapse per 60 s of wall time.
5. **Candidate (B):** remove `swthreads=0` (Auto), **Apply restart**, load the
   same save state, same wait, same readings. Repeat A/B/B/A at least twice;
   single runs on this project swing by 10–30%.
6. For the old core itself, check out `main`, `npm run play`, and repeat step
   4 (that core ignores `swthreads`). Its numbers should match this branch's
   `swthreads=0` arm, which is the parity check.
7. Looking for a wrong pixel is part of the comparison: the two arms must
   produce the same image. Take a screenshot in each arm at the same saved
   frame; `swthreads=0` and `auto` differ only in timing.

Optional, with `?metrics=1`: the DBG panel's stats string should show
`swthreads:N` in the candidate arm and the raster-phase counters stay
available; `swthreads:0` in the baseline.

What to expect: distinct frames scale with the threads that get real cores.
With two workers on an 8-core Mac the pixel loop runs on three threads, so the
~50 ms of per-frame shading drops towards ~17 ms, but the vertex transform,
FIFO decode and XFB encode (~20–25 ms a frame together) still run on the GPU
thread alone, so the ceiling rises from ~13 towards ~25–30 distinct frames,
not to 60. The remaining per-frame serial work on the GPU thread is the next
target.

## What was not done

- The JIT hand-off (`CachedInterpreter::ExecuteOneBlock` → `RunWasmBlock`)
  was left alone: it is the CPU thread's cost and the CPU thread is not the
  unique-frame limit on this path.
- The GPU loop's per-chunk overhead and idle spin were left alone for the
  same reason; see above for why the 28% `SetCPStatusFromGPU` share is spin,
  not work.
- The stale-XFB decode on the CPU thread (`DolphinWeb_OnXfb`) is unchanged;
  it is the natural follow-up once more frames are distinct.
- None of this was measured on a Mac in this change; the numbers above are
  the repository's retained Windows measurements and the arithmetic they
  imply. The procedure above is how to replace them.
