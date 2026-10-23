# WebGPU hardware renderer — open bugs

State of `?video=wgpu` measured across all 45 discs in the test library, same
machine, same harness, same day as the software-hybrid sweep it is compared
against. Every claim below was checked against the canvas screenshot, not the
verdict column.

Reproduce:

```bash
VIDEO=wgpu node tools/boot-matrix.mjs --library "<disc library>" --duration 45
```

## Per-title causes read from the code (2026-10-23)

This pass had no GPU and no discs, so nothing below is a screenshot claim. It
is what the code says about why titles in `src/game-profiles.js` draw wrong on
the hardware path, checked against how upstream's other backends handle the
same cases, and what was changed for it. Every change is reachable from the
profile table, and each title's entry names what to look at when it is
checked by eye (the `test` field).

### Upstream's per-game settings were never loaded

`BootManager::BootCore` adds `ConfigLoaders::GenerateGlobalGameConfigLoader`,
which reads `File::GetSysDirectory() + "GameSettings/<id>.ini"`. This build
fixes the Sys directory at `/dolphin-sys` and embeds only `Data/Sys/Wii`
(patch 0054), so `Data/Sys/GameSettings` does not exist in the wasm filesystem
and **no title has ever had its upstream GameSettings applied, on either
path**. For the library that means, among others:

| title | upstream INI | what it says |
| --- | --- | --- |
| Super Mario Sunshine `GMSE01` | `GMS.ini` | `EFBToTextureEnable = False`, `EFBAccessEnable = True`, `MissingColorValue = 0` |
| Resident Evil Code: Veronica X `GCDE08` | `GCD.ini` | `EFBToTextureEnable = False`, `SafeTextureCacheColorSamples = 512` |
| Zelda OoT / Master Quest `D43E01` | `D43.ini` | `EFBToTextureEnable = False` |
| Zelda Collector's Edition `PZLE01` | `PZL.ini` | `EFBToTextureEnable = False`, `ImmediateXFBEnable = False`, `SafeTextureCacheColorSamples = 0` |
| Wind Waker `GZLE01` | `GZL.ini` | `EFBAccessEnable = True`, `EFBToTextureEnable = False`, `VISkip = False` |
| Paper Mario TTYD `G8ME01` | `G8M.ini` | `EFBToTextureEnable = False`, `BBoxEnable = True`, `DeferEFBCopies = False` |
| Pokemon Channel `GPAE01` | `GPA.ini` | `EFBToTextureEnable = False` |
| Resident Evil Zero `GBZE08` | `GBZ.ini` | `XFBToTextureEnable = False` |
| Four Swords Adventures `G4SE01` / Animal Crossing `GAFE01` | `G4S.ini` / `GAF.ini` | `SafeTextureCacheColorSamples = 512` |

The profile table now carries those `[Video_*]` lines per title and the
worker writes them to `/dolphin-sys/GameSettings/<id>.ini` before `BootDisc`,
so Dolphin's own loader applies them. `[Core]` lines are deliberately not
carried: F-Zero GX's upstream `CPUThread = False` would silently turn off the
dual-core choice the host made.

### EFB copies to RAM, EFB peeks and the bounding box read zeros

The hardware path uses VideoCommon's generic `TextureCacheBase` (the
`InitializeShared` overload without a texture cache), so a copy-to-RAM request
already runs upstream's encoder draw and then calls
`WebGPUStagingTexture::CopyFromTexture` -- which was a stub that set a flag.
`Flush` and `Map` returned a zero-filled buffer. The same stub serves
`FramebufferManager`'s EFB cache (peeks), and the bounding box object was the
Software rasteriser's, which nothing on this path ever updated. So every
title whose upstream INI says `EFBToTextureEnable = False` -- the game reads
the copy back, or composes from it -- got zeros where the software path gets
the real bytes. That is the shape of Code Veronica X's black screen, the N64
emulator discs showing nothing, and Sunshine's goop maps; Paper Mario's paper
effects additionally need the bbox.

Fix: `CmdOp::ReadbackTexture` / `ReadbackBuffer` (patch 0074). The staging
texture publishes the open pass, pushes a readback record naming its heap
buffer and a serial, and futex-waits (bounded, 250 ms) on a completion word;
the consumer copies the rect into a `MAP_READ` buffer, submits at once rather
than at the next present, and after `mapAsync` resolves writes the rows into
the heap and stores the serial. `WebGPUBoundingBox` uploads the game's values
into the shader-updated storage buffer and reads it back the same way. It is
behind renderer feature bit 3 (`readback`, `?wgpureadback=1`), off by
default, and on in the profile of every title above whose upstream INI needs
it -- a readback is a video-thread stall per copy, so it has to be earned.
`ReinterpretPixelData` (EFB format changes, `EFBEmulateFormatChanges = True`
for Mario Kart Wii and Skyward Sword) is still a stub.

### `FORCE_EARLY_Z` is dropped by the shader translation

`bSupportsEarlyZ = true` made `PixelShaderGen` emit `FORCE_EARLY_Z`
(`layout(early_fragment_tests)`) for zcomploc draws that write depth. glslang
turns that into the `EarlyFragmentTests` execution mode; Naga's SPIR-V front
end parses it into `EarlyDepthTest::Force`, and Naga's WGSL back end has no
spelling for it (`src/back/wgsl/` contains no early-depth handling; WGSL has
none), so it is dropped silently. A fragment the alpha test discards then
skips its depth write, which is exactly what the mode exists to prevent.
Upstream's backends that cannot force early-Z report it, and
`PipelineUtils.cpp` applies the zcomploc hack (the alpha test is forced to
pass on those draws, since writing depth matters more than the alpha edge).
Renderer feature bit 1 (`zcomplocHack`, default on) reports no early-Z so the
same fallback runs here; `?wgpuzcomploc=0` restores the old claim.

### Logic ops were approximated after shader generation

`bSupportsLogicOp = true` while WebGPU has no logic ops: the producer called
`BlendingState::ApproximateLogicOpWithBlending` on its own copy of the blend
state after the pipeline was already generated. VideoCommon's own path for
backends without logic ops (`ShaderCache.cpp`, `PipelineUtils.cpp`) does the
same approximation but can also ask the pixel shader for help
(`emulate_logic_op_with_blend`) for the modes blending cannot express, and
that help was never available. Bit 2 (`logicOpInVideoCommon`, default on)
reports no logic ops, as Metal and GLES do; the producer's approximation is
then a no-op.

### Entries whose reason was stale

- `GHAE08`, `D43E01`, `G4SE01`: their "N vs M fps" reasons were measured with
  the hardware visual-fps metric broken (issue #7, always 0) and the JIT
  disable guard fusing the JIT off in heavy scenes (fixed 2026-08-30). The
  later sweep boots RE2 and FSA at 100%. Entries keep software and say so.
- `GRSEAF`: "does not progress" is the autosave dialog waiting for input (see
  "Not bugs"), not a render fault.
- `GMSE01`: the file-select background is claimed fixed by patches 0064/0065
  (uniform-source leak); the entry now says what remains (EFB-to-RAM title).

### What to test, and where it is written down

The PR that lands this lists the titles to check in Chrome; the per-title
`test` strings in `src/game-profiles.js` say what each entry claims. Nothing
in this section moves a title to hardware: that still needs the frame checked
by eye on the hardware path and a speed win.

## Depth convention made consistent for 3D gameplay (2026-10-23, awaiting GPU verification)

Wii titles rendered their menus on `video=wgpu` and lost their gameplay. The
cause is in how depth values left the core, not in the consumer's geometry:

- This backend reports `bSupportsReversedDepthRange = false`, and really does
  run that convention. `BPFunctions::SetScissorAndViewport` maps the vertex
  shader's reverse-Z output through a `near = 1 - max, far = 1 - min` viewport,
  so the EFB depth buffer holds `1 - console depth`; the consumer clears depth
  to 0.0 and flips every depth compare (`REVZ_COMPARE_FLIP`). The in-race
  measurements below -- the world band at z(0.00,0.84) under the HUD at
  z(0.89,0.99), nearer being larger -- are that convention.
- VideoCommon pairs that viewport with a `1 - x` on every other depth value:
  the fog `zCoord`, the per-pixel depth written by z-textures and zfreeze, EFB
  depth copies, EFB depth peeks and pokes, and clear values. Patch 0006 (the
  §28at session) gated all of those off for this backend on the belief that
  its window depth was not inverted. On the hardware path fog therefore ran
  inverted (near fogged, far clear), z-texture depth landed on the wrong side
  of everything, and an EFB depth copy encoded `1 - d`. Those are the effects
  3D gameplay in Wii-era titles is built on -- depth-of-field composites,
  shadow-map and water comparisons, soft particles -- and menus never touch
  them. Plain depth-tested geometry was unaffected, which is why GameCube
  titles without such effects rendered, and why the race fixture matched
  software: Mario Kart Wii's captured world shader computes `zCoord` and never
  uses it (no fog stage), see `docs/diagnostics/mkw-world-fragment-shader.wgsl`.
- The consumer hard-coded the depth clear to 0.0 (the console's far), right for
  the usual `0xFFFFFF` clear and wrong for any other; the producer sent an
  unconverted value, and for sub-rect clears the ClearRect record's depth was
  ignored for the same reason.
- An inverted console depth range (`zRange < 0`, the console's own reverse-Z
  trick) arrived as `near > far`, which WebGPU cannot express; the consumer
  swapped the two and drew those passes inside out, or black against the
  hard-coded clear.

Vendor patch `0076-webgpu-depth-convention`:

- removes the §28at gating, so VideoCommon's `1 - x` conversions apply to this
  backend as to any other without reversed depth ranges;
- sends the real clear depth, in the window convention, in `BEGIN_PASS` (bit 3
  plus bits 8..31 of the load-op word) and `CLEAR_RECT` (flag 16); the consumer
  writes it as sent and keeps the hard-coded 0.0 only for cores that send none
  (`src/wgpu-depth-clear.js`);
- routes inverted console depth ranges through the vertex shader
  (`VertexShaderManager::UseVertexDepthRange`) even without depth clamping, so
  the GPU viewport is always `[0, 1]` and the swap never fires;
- keeps the previous behaviour behind `?wgpudepthlegacy=1` (renderer feature
  mask bit 4, `legacyDepth` in `src/game-profiles.js`) for an A/B on a real title.

**Not verified on a GPU.** The session that made this change had no disc
images and no hardware adapter; the evidence is the code paths above plus the
unit tests on the record encodings. Verify in headed Chrome, per title, on
`video=wgpu&presenter=webgpu` against the software reference: Skyward Sword
and Mario Kart Wii gameplay first, then Melee, F-Zero GX and Wario World for
regression. Fog gradients, depth-of-field and shadow effects are the things
to look at; `?wgpudepthlegacy=1` shows the previous output for the same scene.
Record the result here, with screenshots and the complete URLs, before moving
any Wii title to `hardware` in `src/game-profiles.js`.

## Independent re-verification on a frame-matched fixture (2026-09-08)

The ClearRect work was re-checked from a clean tree by a second pass that did
not carry the original session's state: `fetch:dolphin` + `patch:upstream`
applied all 60 locked patches and reproduced result tree
`5ab4c03989f1942405c6a8fe83e8a151241f378f`, `verify:provenance` passed, and
`npm test` ran 858 tests with 0 failures.

### The comparison problem, and how it was removed

Earlier MKWii comparisons were unsound because the two renderers advance at
different speeds, so screenshots taken at the same wall-clock second are
different game screens. Two changes fix that:

- both paths load the same deterministic save state (`__mkw-race.sav`,
  `SAVE_STATE_AT=0`), so they start from an identical machine state;
- `INPUT_SCRIPT=none` removes the wall-clock-keyed input, which otherwise
  reaches the two paths at different emulated frames;
- frames are then matched by the harness's own emulated frame counter from
  `samples.csv`, not by elapsed time.

That yields pairs one or two emulated frames apart, which is close enough that
the pause camera has not moved.

### Result: same state, three builds

| build | renderer | emulated frame | what the canvas shows |
| --- | --- | ---: | --- |
| `main` | wgpu | 1413 | patchwork: a black band, a brown blur, one strip of track, hard rectangular seams, no world |
| this branch | wgpu | 1381 | course, road, red/white barriers, grass, trees, sky, Luigi Circuit signage, Mario's kart, pause overlay |
| this branch | software | 1398 | the same scene, same colours, same placement |

The hardware frame is also stable rather than merely non-black: the inner
picture region is bit-identical between t=0 and t=44 (0 differing pixels).
The ~30 distinct canvas hashes over that window come from one region,
bounding box x 300..684 / y 492..549 with a maximum channel delta of 67 --
the "Continue Game" selection glow, which is animation, not instability.

### Issue #16's own repro

Driven from boot on `video=wgpu&presenter=webgpu`, the vehicle-select menu --
structurally the screen #16 filed, a large 3D model at left over 2D chrome
with model thumbnails in panes -- renders Mario and his kart in full colour,
and the kart preview panes render red and cream karts with visible wheels and
shading. Not silhouettes.

The blue-and-white checker blocks in those menus are the game's checkered-flag
motif, not transparency: the software path draws the same blocks on its own
menus.

### Melee regression: none

Same fixture (`__battle.sav`, `INPUT_SCRIPT=none`, 45 s, `JITWARMUP=700`,
`FORCEJIT=1`), `video=wgpu&presenter=webgpu`, A/B against a pristine `main`
tree served from a second port:

| build | avg game speed | distinct hashes | avg core fps |
| --- | ---: | ---: | ---: |
| `main` | 47.03% | 46 | 28.27 |
| this branch | 47.81% | 46 | 28.86 |

Kirby vs Link on Great Bay renders correctly on both: water, rock faces,
character models, damage percentages, timer.

### What this does not establish

Mario Kart Wii still averages ~44% game speed on the hardware path against
~100% on software for the same state, so `RMCE01` stays on `software` in
`src/game-profiles.js` -- now on performance grounds rather than the
correctness grounds recorded before.

The software path crops its own output on some Mario Kart Wii screens (menu
dialogs run off the right edge, and the pause overlay is drawn oversized).
That is a software-path presentation fault, unrelated to this work, and it is
why the software reference is used to check colour and content rather than
placement.

## Follow-up: mip chains and clear coverage/channels (2026-09-07)

Three additional renderer defects are fixed:

- **Mip uploads were rejected.** Native textures supplied each mip but
  `CREATE_TEXTURE` allocated only one level. The last record word now carries
  the configured level count (zero from older producers still means one).
  Sampling views expose the chain; framebuffer views select one mip/layer.
  Sampled texture copies now normalize source rectangles using the selected
  mip's dimensions. This follows the [WebGPU texture/view contract](https://www.w3.org/TR/webgpu/#textures).
  Earlier Sunshine, Wario World, Twilight Princess and Star Fox logs contain
  `MipLevel (1) is greater than the number of mip levels (1)` errors.
- **A clear could miss its rectangle.** The depth-range fix below preserved
  the game's viewport rectangle. A clear outside that viewport consequently
  received no fragments. ClearRect now temporarily uses the whole attachment
  and depth range `[0,1]`, then restores the game viewport and scissor. The
  redundant-call fast path still applies when all six viewport values already
  match. The earlier claim that retaining the viewport rectangle was enough
  is superseded by this measured coverage failure.
- **Alpha-only clears were dropped.** Mario Kart Wii's trace contains
  128x128 and 608x456 clears with RGB and depth disabled but alpha enabled.
  The producer recorded no enabled channels. ClearRect now carries separate
  RGB, alpha and depth enables; mixed RGB/alpha clears use the draw path even
  for a whole attachment. Older records retain their RGBA clear semantics.

GPU verification on Chrome/AMD RDNA 4: 19 exact pixel checks cover mip uploads,
layers, sampled subrect copies, format conversion, thin mips, legacy records
and attachment views, with zero validation errors. A separate 8x8 clear probe
requested a 2x2 clear outside a 4x4 game viewport: the old path cleared zero
pixels; the corrected path cleared exactly four color/depth pixels and
preserved the surrounding pixels and game state.
The expanded GPU check verifies ten clear cases, including alpha-only
preserving RGB/depth, RGB-only preserving alpha/depth, depth-only preserving
RGBA, combined clears and legacy records. All 64 pixels are checked per case.

RETRACTED 2026-09-09. Sunshine's file-select background is still white. It
was re-checked on this build and on 97a7409 (which has every diagnostic this
claim was made with), booting from disc and from
`__sunshine-file-select.sav`: white in all four. The archived sweep frames
this claim cites, `canvas-t024.png` and `canvas-t041.png` of
`2026-09-07T03-52-17-254Z/41-super-mario-sunshine-usa`, also show a white
background -- so the screenshots did not support it when it was written. The
speed numbers below stand; the beach does not.
Mario Kart Wii's saved race retained two opaque copied-texture rectangles
after those two fixes. Independent alpha clears removed them: the final
scene shows the road, grass, barriers, kart and pause overlay together, matching
the software reference's scene content. A final trace confirms the 608x456
alpha-only clear is emitted and replayed with flags 12. Placeholder tinting and
global clamp-to-edge sampling had not removed the rectangles; those diagnostic
changes were confined to intercepted browser responses and are not shipped.

Local evidence: `.omx/render-fix/gpu-mip-smoke.{mjs,json}`,
`.omx/render-fix/clear-coverage-smoke.{mjs,json}`,
`.omx/render-fix/sunshine-clear-coverage/`, and
`.omx/render-fix/mkw-clear-coverage/` (before alpha repair), and
`.omx/render-fix/mkw-alpha-final/` (after). Tests execute the actual consumer code
and fail against the previous implementation.

The rebuilt core and ABI hash pin are updated. Snapshot patch 0058 carries
the mip fix; 0059 preserves native ClearRect and diagnostics already present
in the local vendor tree but missing from the patch series. Patch 0060 carries
independent alpha clears. Malformed/context
whitespace in earlier patches was repaired so replay matches that tree.
Both browser harnesses now report adapter fallback errors immediately;
the saved-state harness also waits for app readiness before uploading a ROM.

Final verification: `npm run check`, all 858 tests, and
`npm run verify:provenance` pass. The active browser core hash matches the
rebuilt artifact (`38808e3affc23dfada3fe2d3492e6fa94980916a24c95e24d9cdcc0c6997619c`),
with `WebGPU-Real` active and no fallback. Sunshine and Wario World boot
checks also pass on that final build; screenshots are in
`.omx/render-fix/sunshine-alpha-final/` and
`.omx/render-fix/wario-alpha-final/`. This follow-up verified those scenes,
not a new full-library compatibility sweep.

## Status: the main defect is fixed

`ClearRegion` was honouring depth-only clears as colour clears, wiping a
fully-rendered EFB immediately before the XFB copy. Fixed in patch 0053.
The sections below are kept as the record of how it was found and what
remains.

### Measured after the fix, all 45 discs

**Every speed number recorded before 2026-08-30 is understated.** The JIT
disable guard judged the JIT by presentation rate against a baseline captured
when it engaged, so entering any heavy scene fused the JIT off -- exactly when
it mattered. Fixed by judging on core fps instead. Boot counts before that date
are also suspect: both harnesses read the optional JIT-cache prewarm status as a
fatal mount failure, producing phantom `mount-fail` verdicts (see issue #10).

Current baseline, `video=wgpu`, 46 discs (Wario World extracted from its zip),
2026-09-07, after the ClearRect viewport fix, `JITWARMUP=60`:

| | value |
| --- | ---: |
| boots | 39 (5 static, 2 black) |
| titles at >=95% game speed | 22 |
| titles at >=80% | 23 |

Report: `.omx/boot-matrix/2026-09-07T03-52-17-254Z/results.md`. The five
statics: Animal Crossing x2 (issue #11), SoulCalibur 2 Plus and One Piece
Grand Adventure (both parked on a memory-card dialog, rendering correctly),
and Sonic Adventure DX (black through its intro, renders its attract scene at
30s, and the 45s window ends on a later blank transition -- the Naruto/Paper
Mario pattern, checked three ways below). The two blacks are Resident Evil
Code: Veronica X and GoldenEye Rogue Agent disc 2, which dies with a worker
error at frame 105. Screenshot-verified in this sweep: Kirby Air Ride's race
is in full colour with green grass. (This paragraph also claimed Super Mario
Sunshine's beach background renders behind the file select. It does not --
see the retraction above.)

Per title, same sweep (hashes = distinct canvas frames in 45s):

| game | verdict | hashes | speed % |
| --- | --- | ---: | ---: |
| Animal Crossing (USA, Canada) | static | 3 | 100 |
| Animal Crossing (USA) | static | 6 | 9 |
| F-Zero GX (USA) | boots | 39 | 100 |
| GoldenEye - Rogue Agent (USA) (Disc 2) | black | 1 | 0 |
| Kirby Air Ride (USA) | boots | 41 | 100 |
| Legend of Zelda, The - Collector's Edition (USA, Canada) | boots | 38 | 72.5 |
| Legend of Zelda, The - Four Swords Adventures (USA) | boots | 18 | 100 |
| Legend of Zelda, The - Ocarina of Time & Master Quest (USA, Canada) | boots | 12 | 100 |
| Legend of Zelda, The - The Wind Waker (USA, Canada) | boots | 45 | 100 |
| Legend of Zelda, The - Twilight Princess (USA) | boots | 38 | 100 |
| Luigi's Mansion (USA, Canada) | boots | 44 | 68.5 |
| Luigi's Mansion (USA) | boots | 40 | 67.5 |
| Mario Kart - Double Dash!! (USA) | boots | 30 | 100 |
| Mario Kart Double Dash (USA) | boots | 40 | 99 |
| Metal Gear Solid - The Twin Snakes (USA) (Disc 1) | boots | 26 | 37 |
| Metroid Prime (USA) (Rev 2) | boots | 34 | 36 |
| Metroid Prime 2 - Echoes (USA, Canada) (Bonus Disc) | boots | 35 | 97 |
| Naruto - Clash of Ninja 2 (USA) | boots | 27 | 44 |
| Paper Mario - The Thousand-Year Door (USA) | boots | 20 | 36 |
| Pikmin (USA) (Rev 1) | boots | 43 | 99 |
| Pikmin 2 (USA) | boots | 41 | 53 |
| Pikmin 2 | boots | 34 | 48.5 |
| Pokemon Box - Ruby & Sapphire (USA) (Rev 1) | boots | 45 | 100 |
| Pokemon Channel (USA) | boots | 42 | 45 |
| Pokemon Colosseum (USA) | boots | 28 | 34 |
| Pokemon XD - Gale of Darkness (USA) | boots | 31 | 36 |
| Resident Evil - Code - Veronica X (USA) (Disc 1) | black | 5 | 40 |
| Resident Evil (USA) (Disc 1) | boots | 13 | 100 |
| Resident Evil 2 (USA) | boots | 18 | 100 |
| Resident Evil 3 - Nemesis (USA) | boots | 17 | 100 |
| Resident Evil Zero (USA) (Disc 1) | boots | 20 | 37 |
| Resident Evil Zero (USA) (Disc 2) | boots | 21 | 37 |
| Shadow the Hedgehog (USA) (En,Ja,Fr,De,Es,It) | boots | 24 | 37 |
| Shonen Jump's One Piece - Grand Adventure (USA) | static | 1 | 100 |
| Sonic Adventure 2 - Battle (USA) (En,Ja,Fr,De,Es) | boots | 27 | 39 |
| Sonic Adventure DX - Director's Cut (USA) (En,Ja,Fr,De,Es) | static | 7 | 100 |
| Sonic Heroes (USA) (En,Ja,Fr,De,Es,It) | boots | 42 | 45 |
| SoulCalibur 2 Plus Gamecube version 0.9.9.7 | static | 10 | 63 |
| Soulcalibur II (USA) | boots | 10 | 60 |
| Star Fox Adventures (USA) (Rev 1) | boots | 42 | 28.5 |
| Super Mario Sunshine (USA) | boots | 25 | 80 |
| Super Monkey Ball Deluxe [GM2EDX] | boots | 19 | 100 |
| Super Smash Bros. Melee (USA) (En,Ja) (Rev 2) | boots | 42 | 100 |
| Super Smash Bros. Melee (USA) (En,Ja) (v1.02) | boots | 41 | 97 |
| Wario World (USA) | boots | 45 | 100 |
| Yu-Gi-Oh! The Falsebound Kingdom (USA) | boots | 20 | 100 |

Previous baseline, 45 discs, before the viewport fix:

| | value |
| --- | ---: |
| boots | 41 (2 static, 2 black) |
| titles at >=95% game speed | 13 |
| titles at >=80% | 17 |
| mean unique visual fps | 28.4 |

Verified by eye at full speed: Melee (99.5%, character select), Wario World
(100%, throne room), F-Zero GX (99%). Speed is genuinely per-title, not
measurement drift -- mean by sweep position is 69/42/46/54/74%, with no trend.

Previous figures, kept for comparison: mean unique visual fps 7.1 software vs
23.2 hardware, 32 of 45 higher on hardware, 43 vs 41 boots.

Eight titles hold a locked 60 unique fps at ~100% game speed, each
screenshot-verified: F-Zero GX (8 -> 60 fps, 23% -> 101% speed), Wario World,
Mario Kart Double Dash, Kirby Air Ride, Pikmin 2, Melee (Rev 2), Pokemon Box.

F-Zero GX is the clearest case for the hardware path existing at all: it was
the software rasterizer's worst result in the library and is now among the
best.

### What still fails on the hardware path

| game | verdict | note |
| --- | --- | --- |
| Animal Crossing (RVZ + NKit) | static | issue #11, fails on BOTH backends |
| Resident Evil Code: Veronica X | black | unchanged, uninvestigated |
| Soulcalibur II | static | **not a defect** - parked on its autosave dialog, rendering correctly |
| Super Mario Sunshine | boots | file-select background still white; the 2026-09-07 "fixed" claim was retracted 2026-09-09 (see above). Boots and runs at ~100% speed |

Sunshine proved at least one more frame-destroying path existed; it was the
ClearRect depth going through the viewport, the same defect as Mario Kart
Wii's black world. Of the three
hypotheses previously "measured away", the first was wrong -- see below.

1. **`target_rc` partial clears. NOT falsified; the original reasoning was too
   broad.** The old argument was that the EFB is 640x528 while games clear to
   448 high, so every clear is already partial and Wario World issues 7,800 of
   them and renders correctly. That holds only for a game with ONE viewport,
   where over-clearing empty rows costs nothing. Instrumenting `ClearRegion`
   (patch 0055, `WGPUDEEPDIAG=1`) shows Mario Kart Wii issuing clears of
   128x128 at (0,0), 256x256 at (176,100), 192x96 at (208,180) and 32x32 at
   (0,456) -- small rects at non-zero offsets, each of which currently wipes
   the whole 640x528 EFB. The game sets a matching scissor on most of them.
   The defect is real (issue #17).

   Routing partial clears to VideoCommon's scissored-quad fallback was tried
   and reverted: it ends and restarts a render pass per clear, and Wario
   World's ~7,800 clears a frame drop it to a near-black frame at 2.0 visual
   fps. A working fix needs a clear that does not tear down the pass.

   **Fixed and ON by default (2026-09-06). Opt out with `?wgpuclearrect=0`;
   the older `?disable=0x2000000` spelling still works.** The `ClearRect`
   opcode draws a scissored full-screen triangle inside the open pass, so the
   pass is never torn down. It blanked
   the frame from the day it was added until the cause was measured: it wrote
   the producer's clear depth, 0.9999999403953552, while the `loadOp` path
   writes `dcv = 0.0` because this backend runs the reverse-Z convention and
   flips every flippable compare to the greater family. Against a reference of
   1.0 nothing passes the depth test, so every draw after a depth-clearing
   `ClearRect` was rejected. It now uses the same value the `loadOp` path uses.

   With it enabled, Double Dash renders a full correct 3D scene and Mario Kart
   Wii renders its 2D overlay exactly as on the default path -- where before it
   produced an entirely black frame. (Mario Kart Wii's 3D world stayed black
   for one more reason, found and fixed on 2026-09-06: the clear triangle's
   depth was going through the game's viewport depth range. See the root-cause
   section under the Mario Kart Wii heading below.)

   Five-title A/B, 60-70s each, `video=wgpu presenter=webgpu`, clear path off
   then on:

   | title | off | on |
   | --- | --- | --- |
   | Wario World | 70 hashes, 100%, 60.0 fps | 70 hashes, 100%, 60.0 fps |
   | Melee | 47 hashes, 100% | 41 hashes, 101% |
   | Double Dash | 56 hashes, 100% | 54 hashes, 100% |
   | F-Zero GX | 54 hashes, 100% | 55 hashes, 100% |
   | Pikmin 2 | 24 hashes, 46% | 24 hashes, 47% |

   No regression anywhere. Wario World matters most: it is the title the
   earlier scissored-quad rewrite dropped to 2.0 visual fps, it issues ~7,800
   clears a frame, and it is untouched at a full 60. Hash counts move within
   scene-timing noise and speeds are unchanged.

   Two of the first runs reported `hashes=0 speed=0%` and looked like total
   regressions; both were "Timed out waiting for Dolphin mount", a harness
   startup failure on back-to-back runs, and passed on a retry. Worth checking
   the log before reading a zero as a result.

   The cost of not enabling it is now quantified: the EFB pass is begun 16
   times in one Mario Kart Wii frame with 4 whole-attachment clears, and only
   142 of 390 EFB draws land after the last one. **64% of the frame's geometry
   is destroyed by clears that should not be touching it.**

   Enabling it costs a little speed rather than gaining any. On the
   deterministic save states, default-on versus forced-off: Double Dash 28% vs
   32%, Mario Kart Wii 43% vs 45% -- 4 and 2 points lower, the price of a
   scissored draw per clear instead of a free `loadOp`. The five-title sweep
   above showed no change because those runs are menus and attract modes rather
   than loaded races. Correctness was chosen over the few points; the opt-out
   restores the old behaviour exactly.
2. **The XFB copy is taken too early.** Falsified. The EFB passes before each
   copy use `loadOp=load`, so content accumulates ACROSS the backbuffer
   present. Re-aligning a frame as the span between XFB copies, Sunshine's
   copy captures ~196 draws including its largest batch. The backbuffer
   present is not the GX frame boundary; draw counts split across it look
   discarded and are not.
3. **The renderer cannot draw the scene.** Falsified. `DIAG_EFB_TO_CANVAS`
   (JS-only, no rebuild) blits the EFB straight to the canvas and shows
   Sunshine's complete file-select screen -- beach, palm tree, ocean,
   seagulls, Mario, file boxes, OPTIONS sign.

What remains is downstream of the copy: the **XFB blit source rect** (XFB#47
is a 2560x1024 atlas and the backbuffer is 320x240, so which region is sampled
matters) or the **copy's own source rect** (Sunshine copies 640x448 where
Wario copies 512x448, against a 640x528 EFB).

Methodological note, learned five times on this bug: **structure does not show
content.** Sizes, rects, bind targets and draw counts each produced a confident
wrong reading. The only probe that read actual pixels contradicted the
structural inference immediately. Measure output, not description.

---

## Summary (pre-fix baseline, kept for comparison)

| | software hybrid | `video=wgpu` |
| --- | ---: | ---: |
| boots | 43 | 39 |
| static | 2 | 4 |
| black | 0 | 1 |
| mount-fail | 0 | 1 |

The verdict counts understate the problem. The real split is by content type:

- **2D and UI render correctly.** Wind Waker's save dialog, Mario Kart's mode
  select, Sonic Heroes' team select, F-Zero GX's name entry, Twilight Princess
  and Pikmin 2 memory-card prompts are all correct.
- **3D scene content is missing or wrong.** This is where every defect below
  lives.

Speed is not a compensating win: 10 games faster by more than 5 points, 15
slower, mean 69.8% -> 61.2%. Large wins (F-Zero GX 23 -> 98) sit beside large
losses (Shadow the Hedgehog 101 -> 31). Both are scene-dependent; see the
measurement note in [ARCHITECTURE.md](ARCHITECTURE.md).

## Wii / Mario Kart Wii: presentation is exonerated (2026-09-01)

Mario Kart Wii renders 2D correctly and 3D as flat rectangles. A whole-frame
capture (`?framecap=N`) settles where that comes from.

One frame, present #4000, 586 records:

```
BEGINPASS fb#14 (EFB 640x528)      game renders, ~540 draws
BEGINPASS fb#93 608x456            EFB->XFB copy, binds tex#14
BEGINPASS fb#47 2560x1024          vp 0,0+304x456, binds tex#14
BEGINPASS fb#0 BACKBUFFER 640x480
  VIEWPORT 0,65+640x350            correct widescreen letterbox
  BINDTEX  tex#93 608x456          the XFB entry
  DRAW x1
PRESENT
```

**The EFB viewed directly in-race shows the same breakage as the screen.**
Everything after the EFB carries a defect that already exists in it, so this is
issue #8 and not a presentation bug.

Ruled out with evidence: backbuffer size (was 320x240 against a 640x480
request — real, fixed, symptom persists), the XFB->backbuffer blit's geometry
and buffer choice, the EFB->XFB copy and its source rect, XFB entry population,
and the XFB RAM fallback (104 cache hits, 0 misses). #15's half-width blit is
real but targets fb#47, which nothing samples for presentation.

### Diagnostics available

| flag | what it shows |
| --- | --- |
| `?efbdiag=1` | blits the EFB colour texture straight to the canvas |
| `?efbdiag=2` | blits the XFB entry last presented |
| `?framecap=N` | dumps the Nth present as an ordered pass/draw trace |
| `?jitverbose=1` | ranks instructions that block JIT compilation |

### Reference rig for Mario Kart Wii (2026-09-03)

Every earlier MKW comparison in this file compared two runs driven by the
harness's random input script, which diverge -- so they compared different
scenes. Three retractions came from that. There is now a deterministic rig:

```bash
MSYS_NO_PATHCONV=1 BASE_URL="http://127.0.0.1:8080/"   ROM="F:/Emulation/Wii_ISO/Mario Kart Wii (USA) (En,Fr,Es).iso"   VIDEO=wgpu PRESENTER=webgpu   SAVE_STATE_URL="/__mkw-race.sav" SAVE_STATE_AT=40   INPUT_SCRIPT=none DURATION=80   node tools/menu-progress-validate.mjs
```

`__mkw-race.sav` is an in-race state captured with `SAVE_STATE_CAPTURE_AT`; it
is gitignored (`*.sav`), so re-capture it if missing. `INPUT_SCRIPT=none` is
what makes the scene identical across runs. Swap `VIDEO=software` for the
reference frame: software renders this state correctly, WebGPU does not, which
is what establishes the remaining defects as backend bugs rather than game
state.

**`PRESENTER=webgpu` is required with `VIDEO=wgpu`.** The harness defaults the
presenter to `webgl` for every value of `VIDEO` except `software`. With
`video=wgpu presenter=webgl` the command ring is never consumed --
`completedPassCount = 0` -- the canvas stays static, and the run silently
measures nothing while still reporting fps. Any `video=wgpu` result recorded
without it is suspect.

### Root cause of the black world (2026-09-06): the ClearRect depth went through the viewport

Found by reading the EFB depth buffer INSIDE the frame rather than at present
time (`DIAG_DEPTH_TRACE` in `src/upstream-discio-worker.js`: it ends the EFB
pass after chosen draws and before each depth-clearing ClearRect, copies the
depth and colour attachments in the same encoder, and re-opens the pass with
load ops and the game's state restored).

The clear triangle is a draw, so its depth is subject to the viewport depth
range like any other fragment: `window z = minDepth + z * (maxDepth - minDepth)`.
Mario Kart Wii issues its full-viewport clear while the HUD viewport
z(0.89,0.99) is active, so the "0.0" reverse-Z clear wrote **0.89** across the
whole EFB -- a plane nearer than the entire world band z(0.00,0.84). Every world
fragment then failed `greater-equal` and the world was black; the HUD, at
>= 0.89, passed. Measured in one frame:

| readback | depth in the viewport |
| --- | --- |
| after world draw 1 (carried over from the previous frame's clear) | 0.89 at every texel |
| after 119 world draws, all `greater-equal`/write | still 0.89 everywhere |
| after the HUD draws | max rises to 0.98 |
| after the ClearRect, only non-writing draws in between | 0.89 everywhere again |
| control: clear pipeline z=0.5 under the world viewport z(0.00,0.84) | lands as 0.42 |

The control row is the direct proof of the mechanism. The fix sets the depth
range of the game's viewport to [0,1] for the clear triangle, keeping its
rect, and restores the game's range after it. (A first version also widened
the rect to the full pass; Sonic Adventure DX came out black in the sweep
after it, which turned out to be its intro timing rather than the rect --
identical results with the fix off, on, and rect-preserving -- but the
narrower form is what shipped since nothing needed the wider rect.) With it the trace reads 0.0 after the clear, world depth writes land, the
colour buffer holds the scene before the clear, and the screenshot shows road,
barrier, grass, sky and billboard under the pause overlay -- HUD and world
together, on the reverse-Z convention the shader implies. No `GX_NATIVE_DEPTH`
workaround is needed; it "worked" because its unflipped `less-equal` passed
the world against the 0.99 the clear wrote under that convention.

Deterministic states, `video=wgpu presenter=webgpu`, before -> after: Mario
Kart Wii 43% -> 55% game speed, Double Dash 28% -> 34%, and Double Dash's race
scene is unchanged. The viewport reset is skipped when the game's viewport is
already the full-pass [0,1] one, since Wario World issues ~7,800 clears a
frame. Wario World A/B, fix off -> on, 70s each: 63 -> 65 hashes, 80% -> 93%
average speed, 25 -> 30 present fps, throne room correct both ways. F-Zero GX
boots to its name-entry screen at 63-86% with 48 distinct frames. (The
harness's per-sample speed on Wario World alternates 0%/200% while the frame
counter advances steadily; that is the sampler, so the averages above are the
numbers to read.)

A second state leak of the same kind, fixed alongside: after the clear
triangle, ClearRect restored the scissor to the full pass rather than the
scissor the game had set, so every draw until the game's next scissor change
ran un-scissored. It now restores the game's last scissor. Mario Kart Wii and
Wario World render the same with it (38 and 70 hashes, 66% and 94%).

**Why the previous session's depth readback read all zero, and why the first
two runs of this probe did too, control included:** `mapAsync` was called on
the readback buffer before the encoder that copies into it was submitted. Dawn
rejects that submit ("used in submit while pending map") and drops the whole
command buffer -- the frame's draws, the copy, everything -- while the buffer
still maps and reads the zeros it was created with. The trace now queues every
map and drains the queue after `queue.submit()`. A readback that cannot see
its own control write is a null instrument; that check is what caught it.

### Method note

Three separate single-sample readings during this investigation were wrong:
"the EFB does not contain the 3D world" (the measurement never ran), "presented
entries are sometimes empty" (a readback artifact from encoder batching), and
"the XFB entry has no HUD" (a pre-race intro frame compared against an in-race
one). Each looked decisive. The whole-frame capture exists because piecewise
probes kept producing mutually inconsistent pictures — which is the signature
of measuring the wrong thing, not of a subtle bug.

## Bugs

### 1. 3D geometry missing while 2D overlays draw — FIXED (patch 0053)

The clearest repro in the library, and the one to start from.

- **Wario World** — near-empty frame with two small tan rectangles. The software
  path renders a fully detailed castle throne room from the same scene. 97% game
  speed, `132/381 draw`.

  **Correction:** that figure was long read as "draws submitted and mostly not
  landing". It is not a landed-vs-submitted ratio. The HUD field is
  `prim/draw` -- `g_stats.this_frame.num_prims` over
  `num_draw_calls` (core/upstream/dolphin_web_discio.cpp) -- both counted at
  SUBMISSION by Dolphin. It carries no information about what reached the EFB.
  Wario World reads 136/379 when rendering correctly and 124/380 when rendering
  a near-black frame, so the metric does not even separate working from broken.
- **Super Mario Sunshine** — the "File created." dialog renders correctly on
  pure black. The entire beach scene behind it is absent.

Both show the same shape: overlay/UI geometry survives, world geometry does not.
Draw counts are non-zero, so this is not a submission failure.

### 2. Colour/texture corruption in 3D scenes — FIXED for Luigi's Mansion (same cause)

- **Luigi's Mansion** — the mansion interior renders with correct geometry but
  desaturated to sepia. The software path renders it in full colour.
- **Kirby Air Ride** — the race scene renders but is heavily pink-shifted; grass
  that is green on the software path is pale pink here.

Geometry is right and lighting is plausible, so this points at texture sampling,
format, or a TEV/blend stage rather than at transform or rasterisation.

### 3. Melee mount is intermittent on the hardware path — OPEN (issue #10)

Across four runs of `video=wgpu` on Super Smash Bros. Melee: two boot normally
(96-99% game speed, correct character-select render), two fail with
`mount-fail` after a 120s timeout. Roughly 50%, on the project's primary target.
The software path did not fail to mount once across three full sweeps.

### 4. Unique-frame rate is unmeasurable on the hardware path — FIXED (issue #7)

Every hardware run reports `0.0 visual` while the canvas demonstrably produces
40+ distinct frames. Visual FPS is derived from `xfb-hash`, which the hardware
path bypasses (`visualSampleSource` in `upstream-discio-worker.js`).

This matters more than it looks. The entire justification for the hardware
renderer is beating the software rasteriser's unique-frame ceiling, and that
number currently cannot be measured on the path meant to beat it. Any perf claim
about `video=wgpu` is unsupported until this is fixed.

### 5. Resident Evil Code: Veronica X renders black — OPEN

Verdict `black` for the whole window. Lower confidence than the others: the
software run was on a different scene at the 45s mark, so this may be an FMV
rather than a defect. Confirm against an earlier checkpoint before chasing it.

## Not bugs

Recorded so they are not re-investigated:

- **Naruto and Paper Mario** end their window on a blank frame on *both* paths.
  They are mid-FMV transition at 45s and render correctly at earlier checkpoints.
- **SoulCalibur 2 Plus** is `static` because it holds an autosave dialog. The
  frame is correct.

## Earlier investigation priorities (superseded)

These priorities predate the clear fixes above and remain as investigation history:

1. **Super Mario Sunshine's missing background.** The one open rendering
   defect with a clear repro, but FIVE hypotheses have now been measured and
   rejected (see above, plus "presentation reads the EFB" -- Wario World
   renders correctly with a 0%-lit EFB at present time). Do NOT continue
   instrumenting the pipeline's description. Every wrong reading so far came
   from inferring content from structure: sizes, rects, bind targets, draw
   counts. Read back the BACKBUFFER TEXTURE itself after present, and bisect
   by suppressing individual passes to see which removal changes the image.
2. **Animal Crossing (#11).** Fails on both backends, so it is not a hardware-
   path bug. The EFB receives 178-188M colour writes and the presented buffer
   is still exactly zero, so the fault is in the EFB -> XFB copy.
3. **Melee mount intermittency (#10).** Needs a repeat-count harness; a single
   green run proves nothing.
4. **Kirby Air Ride colour (#9).** Never re-verified like-for-like -- the
   original report was a race scene, the post-fix check reached player select.
5. **Resident Evil Code: Veronica X.** Lowest confidence that it is a defect
   at all.

Screenshots for every game and checkpoint are written to the sweep output
directory (`page-t*.png` for HUD state, `canvas-t*.png` for the rendered frame).
