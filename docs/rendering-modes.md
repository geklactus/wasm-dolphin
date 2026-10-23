# Rendering modes

Rendering and presentation are separate choices on the software path. The
`video` flag selects Dolphin's rendering backend; `presenter` selects how a
software-rendered framebuffer reaches the browser canvas.

> **Warning:** Do not describe `video=webgpu` as the hardware WebGPU renderer.
> Use `video=wgpu` for the true hardware renderer.

| URL flag | Meaning | Recommended? | Notes |
| --- | --- | --- | --- |
| `video=software&presenter=webgpu` | Software rasterizer + WebGPU presenter | Yes | Default/recommended playable path |
| `video=software&presenter=webgl` | Software rasterizer + WebGL presenter | Fallback | Use if WebGPU presenter fails |
| `video=software&presenter=canvas` or `presenter=2d` | Software rasterizer + 2D canvas | Diagnostic fallback | Slowest/simple path |
| `video=webgpu` | Legacy/alias hybrid path, not true hardware WebGPU | Avoid in docs | Keep for compatibility if code supports it |
| `video=wgpu` | True WebGPU hardware renderer | Experimental | Fixed battle renders on the validation GPU; remains slow and GPU-dependent |
| `video=ogl` | OGL/WebGL2-style path | Experimental/diagnostic | JIT defaults differ here |
| `oglsab=1` | SharedArrayBuffer pixel transport for OGL readback | Diagnostic | Requires cross-origin isolation |

## Software-hybrid path

```text
Dolphin software rasterizer -> EFB/XFB -> browser presenter -> canvas
```

WebGPU accelerates the last presentation/blit step only. Correct rendering
still comes from Dolphin's CPU software rasterizer, so its cost limits the
cadence of distinct visual frames. The WebGL and 2D presenters retain the same
software rasterization stage and are useful fallbacks or diagnostics.

`fastsw=0` is the literal full-resolution upstream software setting.
`fastsw=1` is the balanced/crisp recommended fast mode. `fastsw=2` and
`fastsw=3` use more aggressive raster/encode approximations; they can raise
distinct-frame cadence but are not guaranteed to raise game speed.

`swthreads=auto` (default) rasterizes each draw batch across worker threads by
horizontal EFB bands; `swthreads=0` is the single-threaded upstream rasterizer
and `swthreads=N` forces `N` workers (1-8). The image is identical in every
mode; only the time per frame changes. See
[software raster threads](software-raster-threads.md).

## Hardware and diagnostic paths

`video=wgpu` routes Dolphin draw work through the experimental WebGPU hardware
backend. It depends on the [Rust/Naga shader bridge](webgpu-naga-bridge.md) and
is not the recommended gameplay path. The command replay pump and bounded
16,384-record credit window are enabled for this backend after repeated A/B
evidence; use `wgpupump=0` only as a rollback/diagnostic comparison.

`wgpuubometrics=1` enables detailed producer-side UBO timing and change-mask
histograms for hardware-WGPU experiments. It requires `video=wgpu&metrics=1`
and is default-off because its per-draw clocks and atomic counters perturb the
path being measured. Ordinary `metrics=1` keeps general telemetry without
activating this detailed UBO instrumentation.

`video=ogl` is an OGL/WebGL2-style diagnostic backend. Its JIT safety behavior
is intentionally more conservative; see [JIT flags](jit-flags.md).

`oglsab=1` enables shared-memory pixel transport for an OGL readback workflow.
It only works when the page is cross-origin isolated, such as when served by
the repository's development server with its COOP/COEP headers.
