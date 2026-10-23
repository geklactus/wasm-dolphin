import { verifyWasmToolchain } from "./wasm-toolchain.mjs";

// --record: take the binary hashes from the installed tools and write them to the platform's
// lock (versions and commits are still checked). See verifyWasmToolchain.
const record = process.argv.includes("--record");

try {
  const result = verifyWasmToolchain({ record });
  console.log(
    `${record ? "Recorded" : "Verified"} pinned WASM toolchain in ${result.lockPath} ` +
    `(${result.lock.emscripten.version}, ${result.lock.rust.rustcVersion})`
  );
} catch (error) {
  console.error(`WASM toolchain ${record ? "recording" : "verification"} failed: ${error.message}`);
  process.exitCode = 1;
}
