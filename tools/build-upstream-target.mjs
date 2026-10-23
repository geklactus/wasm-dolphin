import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { packageCoreCandidate, writeCoreBuildInfo } from "./core-build-info.mjs";
import { verifyWasmToolchain } from "./wasm-toolchain.mjs";

const root = process.cwd();
const buildDir = resolve(process.env.DOLPHIN_WASM_BUILD_DIR ?? resolve(root, "build/dolphin-wasm"));
const target = process.argv[2] ?? "discio";

if (!existsSync(resolve(buildDir, "CMakeCache.txt"))) {
  console.error("build/dolphin-wasm is not configured. Run npm run configure:upstream first.");
  process.exit(1);
}

const toolchain = verifyWasmToolchain();
// BUILD_KEEP_GOING=1 lets Ninja carry on past the first failing file (-k 0), so one run of a
// build that is being fixed up reports every error rather than the first four.
const buildArguments = ["--build", buildDir, "--target", target, "--parallel", process.env.BUILD_PARALLELISM ?? "8"];
if (process.env.BUILD_KEEP_GOING === "1") buildArguments.push("--", "-k", "0");
const result = spawnSync(toolchain.paths.cmake, buildArguments, { encoding: "utf8", stdio: "inherit" });

if (result.error || result.status !== 0) {
  process.exit(result.status || 1);
}

if (target === "dolphin_web_core") {
  const buildInfo = writeCoreBuildInfo({ buildDir });
  console.log(`Wrote core build evidence to ${buildInfo.destination}`);
  const candidate = packageCoreCandidate(buildInfo.destination);
  console.log(`Packaged content-addressed core candidate at ${candidate.destination}`);
}
