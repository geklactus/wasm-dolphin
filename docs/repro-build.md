# Reproducible upstream-core build

The repository fetches upstream Dolphin into the gitignored `vendor/dolphin/`
tree, verifies and applies the browser patch snapshot, configures an
Emscripten/Ninja build, and writes the browser core into `cores/dolphin/`.

## Toolchain record

The committed `provenance/wasm-toolchain.lock.json` pins the exact local
toolchain used for the research core. `npm run verify:toolchain` rejects a
version or executable hash mismatch before configuration.

| Component | Version/revision |
| --- | --- |
| Node.js | `24.12.0` |
| Emscripten SDK | `5.0.7`; compiler `263db4cffa6f9fc2ec514a70abac81362ea41849`; emsdk `bafd64c26bdaf10bd829163d1575b50b759a72d8` |
| CMake | `4.3.2` |
| Ninja | `1.13.0.git.kitware.jobserver-pipe-1` |
| Rust nightly | `1.97.0-nightly`; rustc `7c3c88f42ad444f4688b865591d84660be4ece2f` |
| Rust target | `wasm32-unknown-emscripten` |
| Naga | `26.0.0`, with the full Cargo graph locked |
| Chrome | `149.0.7827.201` for headed diagnostics; record each performance run separately |
| Upstream Dolphin commit | `e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1` |

The Naga static library uses nightly Rust because its Emscripten pthread build
rebuilds `std` with atomics and bulk-memory support. Install nightly plus
`rust-src`, add the `wasm32-unknown-emscripten` target, and build the crate as
documented in [the bridge guide](webgpu-naga-bridge.md) when the hardware
WebGPU shader path is required.

## Linux, and the build-core workflow

The Windows lock above is `provenance/wasm-toolchain.lock.json`; Linux has its own,
`provenance/wasm-toolchain.linux-x64.lock.json`, with the same versions and commits
(Rust `nightly-2026-05-15`, which is the pinned rustc). `verify:toolchain` picks the lock
for the platform it runs on. A new platform lock starts with `null` hashes:
`npm run record:toolchain` fills them from the installed tools (still checking every
version and commit), and from then on the hashes are verified like the Windows ones.

`.github/workflows/build-core.yml` builds the core on an `ubuntu-24.04` runner from
those pins — emsdk at the locked commit, CMake and Ninja from PyPI, the Rust nightly with
`rust-src` and the Emscripten target — with `ccache` in front of `emcc`
(`DOLPHIN_WASM_COMPILER_LAUNCHER`, recorded in the configure evidence). It runs on pushes
to `rebase/**` and `core/**` branches, on pull requests, and by hand. The core, its build
record and the content-addressed candidate come out as the `dolphin-core` artifact; the
first run on a lock with `null` hashes also uploads the recorded lock (`toolchain-lock`)
to commit. Promoting a CI core into `cores/dolphin/` is a commit, as it always was.

## Moving the upstream pin

The patch series is maintained as commits on a branch of `vendor/dolphin` — one commit
per snapshot patch, subject = the patch file's name without `.patch` — on top of the
pinned upstream commit. To move the pin: set the new commit in
`provenance/dolphin-source.lock.json` (`upstream.commit` and `repositories["."].commit`),
rebase the branch onto it, resolve what conflicts, then

```sh
npm run export:patches        # rewrites patches/dolphin-wasm/snapshot/ from the branch
npm run update:provenance     # re-locks the series and the virtual vendor snapshot
```

and let the workflow build it. The committed core and `provenance/dolphin-core-abi-v1.json`
still describe the previous pin until a core built from the new one is promoted, so
`verify:provenance` reports that mismatch in between.

## Commands

From a clean repository checkout in PowerShell:

```powershell
npm install
npm test
npm run check
npm run verify:provenance
npm run verify:toolchain
npm run fetch:dolphin
npm run patch:upstream
npm run configure:upstream
npm run build:upstream:full-core
```

The final target produces:

- `cores/dolphin/dolphin-core-upstream.js`
- `cores/dolphin/dolphin-core-upstream.wasm`
- `cores/dolphin/dolphin-core-upstream.build.json`

The build script also packages an ignored, content-addressed candidate under
`build/core-candidates/<wasm-sha256>/`. It contains the JS, WASM, build record,
source/ABI/vendor/toolchain locks, Cargo lock, and a manifest of file hashes.
Use `?coreid=sha256:<wasm-sha256>` to test it. The browser checks the full WASM
SHA-256 before execution and rolls a rejected candidate back to the pinned
baseline before transferring the canvas.

`fetch:dolphin` reads `provenance/dolphin-source.lock.json`, fetches the exact
commit above, verifies the fetched object, and checks it out detached. It never
uses a moving branch head. `patch:upstream` verifies every active patch's
canonical SHA-256, byte size, order, target repository, and base commit before
applying it. The root `HEAD` remains the pristine upstream base after patches
are applied, so this command proves only the base commit:

```powershell
git -C vendor/dolphin rev-parse HEAD
```

The durable patched identity is the virtual result tree. Re-running the patch
command classifies the complete root and submodule status, rejects extra dirty
or untracked paths, rejects index flags that can hide changes (including
assume-unchanged and skip-worktree), recomputes every result blob and tree, and
reports:

```text
verified result tree 3cc63e7a1417574b2fab1ee0c6b483fc49343b91
```

The active lock contains eleven root snapshot patches and two patches applied
in the pinned SFML and xxHash submodules. It captures the complete forensic
delta, including the hardware-WebGPU/Naga call site, software-raster phase
profile, JIT emitter diagnostics, and WGPU upload watermark. The ordered
patch-set SHA-256 is
`05fc890838da65a459ad04a57ddc91259540e00d0571475d325ec32557d9dde0`.
The virtual vendor snapshot content SHA-256 is
`f2345b18d9345043727ef886e18d0c060080de753d68604b1d20fc32476c34ab`.
The older top-level
`0001`-`0009` files remain research history and are not applied by the locked
build. See [the bridge guide](webgpu-naga-bridge.md).

## Existing artifact and ABI identity

`provenance/dolphin-core-abi-v1.json` independently identifies the current
baked core:

| Artifact | Canonical size | SHA-256 |
| --- | ---: | --- |
| `dolphin-core-upstream.js` | 261,633 normalized bytes | `56c62ffc376806049b3442d66df5b72a8685796e39ab79931282fcb286a3b163` |
| `dolphin-core-upstream.wasm` | 12,815,061 bytes | `158dde37602442bf1dacf42328501082b46b47768b2455946fcb4c596fcdb5ea` |

The JS digest is calculated after CRLF-to-LF normalization, and
`.gitattributes` requires LF for core JS files. This prevents checkout line
ending policy from changing the identity of semantically identical glue. The
WASM digest is always over raw bytes. ABI verification also checks the public
Module exports and the 24,576-page (1.5 GiB) shared-memory contract in the JS
glue, WASM import, C++ dynamic-JIT wrapper, and active patch series.

Build success alone does not establish gameplay parity. Compare two independent
build records with `npm run compare:core-builds -- <left> <right>`, then run the
fixed Kirby-versus-Link save smoke on the candidate and on the default baseline.

Two independent builds of this core matched byte-for-byte. The independent
records include an identical 10,322,762-byte code section (SHA-256
`e7de8131567eba0b8f64e1d1fcc24e4d849f553a9e425c9ff82209fe9a2b5b02`)
and 2,451,983-byte data section (SHA-256
`aa01b9bc6d7892a16d3d8d692248e7646b6401232eba4d853fa4b1503ae91484`).
The current parity and gameplay evidence are summarized in the
[software-raster phase package](perf-results/melee-software-raster-phases-2026-07-10.md).

## Known local assumptions

The current lock is deliberately Windows x64-specific. Scripts resolve common
Windows locations and accept `EMCC`, `EMCMAKE`, `CMAKE`, `NINJA`, `RUSTC`,
`CARGO`, and `RUSTUP` overrides only when the selected file still matches the
locked hash. `DOLPHIN_WASM_BUILD_DIR`, `DOLPHIN_WASM_OUTPUT_DIR`, and
`BUILD_PARALLELISM` select isolated build/output locations without weakening
the toolchain check.

The Rust bridge archive is generated beneath
`tools/naga-spirv-wgsl/target/` and is intentionally ignored. The patched
upstream source tree is also ignored; commit the patch inputs and the intended
build record, not `vendor/dolphin/`.

## Release/reproduction checklist

- [x] Record the upstream Dolphin commit.
- [x] Confirm the complete upstream patch snapshot is committed and replayable.
- [x] Record the Emscripten version and compiler/emsdk commits.
- [x] Record the Rust toolchain, Naga version, and Cargo lock.
- [x] Record the existing `.wasm` byte size and SHA-256 hash.
- [x] Record the Chrome version used for the current headed diagnostics.
- [x] Rebuild twice in separate clean directories and establish parity.
- [x] Run `npm test` and `npm run check` from the recorded checkout.
- [x] Store measured gameplay evidence separately from build success.

Useful artifact commands:

```powershell
npm run verify:provenance
(Get-Item cores/dolphin/dolphin-core-upstream.wasm).Length
Get-FileHash cores/dolphin/dolphin-core-upstream.wasm -Algorithm SHA256
```
