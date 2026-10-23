import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, dirname, relative, resolve } from "node:path";
import { sha256File, verifyWasmToolchain } from "./wasm-toolchain.mjs";

const root = process.cwd();
const sourceDir = resolve(root, "vendor/dolphin");
const buildDir = resolve(process.env.DOLPHIN_WASM_BUILD_DIR ?? resolve(root, "build/dolphin-wasm"));
const bridgeSource = resolve(root, "core/upstream/dolphin_web_discio.cpp");
const sharedSourceDir = dirname(bridgeSource);
const coreSource = resolve(root, "core/upstream/dolphin_web_core.cpp");
const outputDir = resolve(process.env.DOLPHIN_WASM_OUTPUT_DIR ?? resolve(root, "cores/dolphin"));
const nagaDir = resolve(root, "tools/naga-spirv-wgsl");
const nagaLibrary = resolve(nagaDir, "target/wasm32-unknown-emscripten/release/naga_spirv_wgsl.a");
const nagaLibraryAlternate = resolve(nagaDir, "target/wasm32-unknown-emscripten/release/libnaga_spirv_wgsl.a");
const jitCachePreJs = resolve(root, "tools/jit-cache-prejs.js");
const wasmMemoryPages = 24576;
const fastBranchInline = String(
  process.env.DOLPHIN_WEB_INLINE_FAST_BRANCH ?? "1"
).trim();
if (!["0", "1"].includes(fastBranchInline)) {
  throw new Error(
    `DOLPHIN_WEB_INLINE_FAST_BRANCH must be 0 or 1, got ${JSON.stringify(fastBranchInline)}`
  );
}
const fallbackMapDiagnostics = String(
  process.env.DOLPHIN_WEB_FALLBACK_MAP_DIAGNOSTICS ?? "0"
).trim();
if (!["0", "1"].includes(fallbackMapDiagnostics)) {
  throw new Error(
    `DOLPHIN_WEB_FALLBACK_MAP_DIAGNOSTICS must be 0 or 1, got ${JSON.stringify(fallbackMapDiagnostics)}`
  );
}
const fallbackMapBits = String(
  process.env.DOLPHIN_WEB_FALLBACK_MAP_BITS ?? "16"
).trim();
if (!["16", "18", "20"].includes(fallbackMapBits)) {
  throw new Error(
    `DOLPHIN_WEB_FALLBACK_MAP_BITS must be 16, 18, or 20, got ${JSON.stringify(fallbackMapBits)}`
  );
}
const directWasmBlockDispatch = String(
  process.env.DOLPHIN_WEB_DIRECT_WASM_BLOCK_DISPATCH ?? "0"
).trim();
if (!["0", "1"].includes(directWasmBlockDispatch)) {
  throw new Error(
    `DOLPHIN_WEB_DIRECT_WASM_BLOCK_DISPATCH must be 0 or 1, got ${JSON.stringify(directWasmBlockDispatch)}`
  );
}

function quoteShellArg(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function run(command, args, options = {}) {
  const isWindowsBatch = process.platform === "win32" && /\.(bat|cmd)$/i.test(command);
  const result = spawnSync(isWindowsBatch ? [command, ...args].map(quoteShellArg).join(" ") : command, isWindowsBatch ? [] : args, {
    encoding: "utf8",
    stdio: "inherit",
    shell: isWindowsBatch,
    ...options
  });

  if (result.error || result.status !== 0) {
    process.exit(result.status || 1);
  }
}

if (!existsSync(resolve(sourceDir, "CMakeLists.txt"))) {
  console.error("vendor/dolphin is missing. Run npm run fetch:dolphin first.");
  process.exit(1);
}

mkdirSync(buildDir, { recursive: true });
mkdirSync(outputDir, { recursive: true });

const toolchain = verifyWasmToolchain();
const { emcc, emcmake, cmake, ninja, cargo, rustc } = toolchain.paths;
const nagaEnvironment = {
  ...process.env,
  PATH: [dirname(rustc), dirname(emcc), process.env.PATH ?? ""].join(delimiter),
  RUSTC: rustc,
  CARGO: cargo
};

console.log("Building the pinned Naga SPIR-V to WGSL bridge");
run(cargo, ["build", "--locked", "--release", "--target", toolchain.lock.rust.target], {
  cwd: nagaDir,
  env: nagaEnvironment
});
const resolvedNagaLibrary = existsSync(nagaLibrary) ? nagaLibrary : nagaLibraryAlternate;
if (!existsSync(resolvedNagaLibrary)) {
  console.error(`Pinned Naga build did not produce ${nagaLibrary} or ${nagaLibraryAlternate}`);
  process.exit(1);
}

// CMake runs hundreds of feature probes. Keep the original global production
// flags so subprojects that replace their Release flags still retain LTO, but
// make try_compile use Debug and append overrides that disable optimization
// and LTO for probes only. Clang/Emscripten honors the last -O*/-f*lto option.
const wasmCompileFlags =
  "-O3 -pthread -msimd128 -flto -DXXH_VECTOR=0 -DDOLPHIN_WEB_HOT_COUNTERS=0 " +
  `-DDOLPHIN_WEB_INLINE_FAST_BRANCH=${fastBranchInline} ` +
  `-DDOLPHIN_WEB_FALLBACK_MAP_DIAGNOSTICS=${fallbackMapDiagnostics} ` +
  `-DDOLPHIN_WEB_FALLBACK_MAP_BITS=${fallbackMapBits} ` +
  `-DDOLPHIN_WEB_DIRECT_WASM_BLOCK_DISPATCH=${directWasmBlockDispatch}`;
const wasmDebugProbeFlags = "-O0 -fno-lto";
const cmakeArgs = [
  cmake,
  "-S",
  sourceDir,
  "-B",
  buildDir,
  "-GNinja",
  `-DCMAKE_MAKE_PROGRAM=${ninja}`,
  "-DCMAKE_BUILD_TYPE=Release",
  "-DCMAKE_TRY_COMPILE_CONFIGURATION=Debug",
  "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
  "-DUSE_SYSTEM_LIBS=OFF",
  "-DENABLE_GENERIC=ON",
  "-DENABLE_QT=OFF",
  "-DENABLE_NOGUI=OFF",
  "-DENABLE_CLI_TOOL=OFF",
  "-DENABLE_HEADLESS=OFF",
  "-DENABLE_ALSA=OFF",
  "-DENABLE_PULSEAUDIO=OFF",
  "-DENABLE_CUBEB=OFF",
  "-DENABLE_X11=OFF",
  "-DENABLE_EGL=OFF",
  "-DENABLE_SDL=OFF",
  "-DENABLE_VULKAN=OFF",
  "-DENABLE_LLVM=OFF",
  "-DENABLE_TESTS=OFF",
  "-DUSE_UPNP=OFF",
  "-DUSE_DISCORD_PRESENCE=OFF",
  "-DUSE_MGBA=OFF",
  "-DUSE_RETRO_ACHIEVEMENTS=OFF",
  "-DENABLE_AUTOUPDATE=OFF",
  "-DENABLE_ANALYTICS=OFF",
  "-DENCODE_FRAMEDUMPS=OFF",
  "-DWITH_OPTIM=OFF",
  "-DWITH_SSE2=OFF",
  "-DWITH_SSSE3=OFF",
  "-DWITH_SSE41=OFF",
  "-DWITH_SSE42=OFF",
  "-DWITH_PCLMULQDQ=OFF",
  "-DWITH_AVX2=OFF",
  "-DWITH_AVX512=OFF",
  "-DWITH_AVX512VNNI=OFF",
  "-DWITH_VPCLMULQDQ=OFF",
  `-DCMAKE_C_FLAGS:STRING=${wasmCompileFlags}`,
  `-DCMAKE_CXX_FLAGS:STRING=${wasmCompileFlags}`,
  `-DCMAKE_C_FLAGS_DEBUG:STRING=${wasmDebugProbeFlags}`,
  `-DCMAKE_CXX_FLAGS_DEBUG:STRING=${wasmDebugProbeFlags}`,
  `-DDOLPHIN_WASM_NAGA_WGSL_LIB=${resolvedNagaLibrary}`,
  `-DDOLPHIN_WASM_JIT_CACHE_PRE_JS=${jitCachePreJs}`,
  `-DDOLPHIN_WASM_MEMORY_PAGES=${wasmMemoryPages}`
];

// The vendored CMakeLists needs this project's root to locate the Naga
// staticlib and the jit-cache pre-js. CMAKE_SOURCE_DIR there is the vendored
// Dolphin tree, not this repo. It can derive the root from the core source
// path, but pass it explicitly so a clone at any path links correctly.
cmakeArgs.push(`-DDOLPHIN_WASM_PROJECT_ROOT=${root.replace(/\\/g, "/")}`);

// DOLPHIN_WASM_COMPILER_LAUNCHER=ccache (or sccache) puts a compiler cache in front of emcc
// so a CI rebuild after a one-file change does not recompile all of Dolphin. It changes
// nothing about the output; the launcher is recorded in the configure evidence.
const compilerLauncher = (process.env.DOLPHIN_WASM_COMPILER_LAUNCHER ?? "").trim();
if (compilerLauncher) {
  cmakeArgs.push(`-DCMAKE_C_COMPILER_LAUNCHER=${compilerLauncher}`);
  cmakeArgs.push(`-DCMAKE_CXX_COMPILER_LAUNCHER=${compilerLauncher}`);
}

// PROFILING_FUNCS=1 adds a wasm name section to the core so CPU profiles show
// real symbols instead of wasm-function[N]. Name section only — no codegen or
// optimisation change, so timings stay representative. Off by default.
if (process.env.PROFILING_FUNCS === "1") {
  // The -D was on its own for a while, and nothing in the vendored CMake ever
  // read it: the configure step logged that it was building with symbols, the
  // link never got the flag, and the profile still read wasm-function[N].
  // Pass the flag itself so the setting cannot be advertised without taking
  // effect.
  cmakeArgs.push("-DDOLPHIN_WASM_PROFILING_FUNCS=ON");
  cmakeArgs.push("-DCMAKE_EXE_LINKER_FLAGS:STRING=--profiling-funcs");
  console.log("PROFILING_FUNCS=1 -> core will be built with a wasm name section");
}

if (existsSync(bridgeSource)) {
  cmakeArgs.push(`-DDOLPHIN_WASM_BRIDGE_SOURCE=${bridgeSource}`);
  cmakeArgs.push(`-DDOLPHIN_WASM_SHARED_SOURCE_DIR=${sharedSourceDir}`);
  cmakeArgs.push(`-DDOLPHIN_WASM_OUTPUT_DIR=${outputDir}`);
}

if (existsSync(coreSource)) {
  cmakeArgs.push(`-DDOLPHIN_WASM_CORE_SOURCE=${coreSource}`);
  cmakeArgs.push(`-DDOLPHIN_WASM_OUTPUT_DIR=${outputDir}`);
}

console.log(`Configuring upstream Dolphin for Emscripten in ${buildDir}`);
run(emcmake, cmakeArgs);
writeFileSync(resolve(buildDir, "wasm-dolphin-configure.json"), `${JSON.stringify({
  schemaVersion: 1,
  sourceDir,
  buildDir,
  outputDir,
  bridgeSource,
  sharedSourceDir,
  coreSource,
  nagaLibrary: resolvedNagaLibrary,
  nagaLibrarySha256: sha256File(resolvedNagaLibrary),
  jitCachePreJs,
  wasmMemoryPages,
  fastBranchInline,
  fallbackMapDiagnostics,
  fallbackMapBits,
  directWasmBlockDispatch,
  compilerLauncher: compilerLauncher || undefined,
  wasmCompileFlags,
  cmakeArgs,
  toolchainLock: relative(root, toolchain.lockPath).replace(/\\/g, "/"),
  toolchainLockSha256: toolchain.hashes.lock,
  cargoLockSha256: toolchain.hashes.cargoLock
}, null, 2)}\n`);
console.log("Configured. Probe targets with: cmake --build build/dolphin-wasm --target discio --parallel 8");
