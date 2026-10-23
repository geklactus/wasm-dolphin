import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const executableSuffix = isWindows ? ".exe" : "";
const scriptSuffix = isWindows ? ".bat" : "";

// One lock per platform. provenance/wasm-toolchain.lock.json is the original Windows lock;
// other platforms keep theirs beside it as wasm-toolchain.<platform>-<arch>.lock.json
// (the Linux one is what the build-core workflow verifies against).
export const platformKey = `${process.platform}-${process.arch}`;
function resolveLockPath() {
  const specific = resolve(root, `provenance/wasm-toolchain.${platformKey}.lock.json`);
  return existsSync(specific) ? specific : resolve(root, "provenance/wasm-toolchain.lock.json");
}
const lockPath = resolveLockPath();

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256NormalizedTextFile(path) {
  return createHash("sha256")
    .update(readFileSync(path, "utf8").replaceAll("\r\n", "\n"))
    .digest("hex");
}

function normalizedTextBytes(path) {
  return Buffer.from(readFileSync(path, "utf8").replaceAll("\r\n", "\n"));
}

function environmentValue(name) {
  if (name === "HOME" || name === "USERPROFILE") return process.env[name] ?? homedir();
  return Object.entries(process.env).find(([key]) =>
    isWindows ? key.toLowerCase() === name.toLowerCase() : key === name
  )?.[1];
}

// Candidate paths may name environment variables as %VAR% (Windows), $VAR or ${VAR}, and may
// start with ~. A candidate whose variable is not set is skipped, not an error: the next
// candidate or the PATH lookup may still find the tool.
function expandCandidate(candidate) {
  let missing = false;
  const expanded = String(candidate)
    .replace(/^~(?=\/|$)/, () => homedir())
    .replace(/%([^%]+)%|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, a, b, c) => {
      const value = environmentValue(a ?? b ?? c);
      if (value === undefined) missing = true;
      return value ?? "";
    });
  return missing ? null : resolve(expanded);
}

function pathCandidate(command) {
  const lookup = isWindows
    ? spawnSync("where.exe", [command], { encoding: "utf8", windowsHide: true })
    : spawnSync("which", [command], { encoding: "utf8" });
  if (lookup.status !== 0) return null;
  return lookup.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

// Finds a tool and, unless { hashed: false }, checks its SHA-256 against the lock (or
// records it). A tool is hashed when its bytes shape the core; one that only locates or
// installs the others (rustup) is found but not hashed, so an image refresh of that
// binary alone does not break the lock.
function resolveTool(label, envName, candidates, expectedSha256, pathCommand, recorded, { hashed = true } = {}) {
  const attempted = [];
  const values = [
    process.env[envName],
    ...(candidates ?? []).map(expandCandidate),
    pathCommand && pathCandidate(pathCommand)
  ].filter(Boolean);

  for (const value of values) {
    const path = resolve(value);
    attempted.push(path);
    if (!existsSync(path)) continue;
    if (!hashed) return path;
    const actual = sha256File(path);
    if (recorded) {
      recorded.set(label, actual);
    } else {
      invariant(
        expectedSha256,
        `${label} has no hash in ${lockPath}; run "node tools/verify-wasm-toolchain.mjs --record" on a machine with the pinned toolchain installed`
      );
      invariant(
        actual === expectedSha256,
        `${label} hash mismatch at ${path}: expected ${expectedSha256}, got ${actual}`
      );
    }
    return path;
  }

  throw new Error(`${label} was not found. Checked: ${attempted.join(", ") || "(nothing)"}`);
}

function runVersion(command, args) {
  const isBatch = isWindows && /\.(bat|cmd)$/i.test(command);
  const executable = isBatch ? (process.env.ComSpec ?? "cmd.exe") : command;
  const executableArgs = isBatch ? ["/d", "/s", "/c", command, ...args] : args;
  const result = spawnSync(executable, executableArgs, {
    encoding: "utf8",
    windowsHide: true
  });
  invariant(!result.error && result.status === 0, `Could not run ${command} ${args.join(" ")}`);
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

function requireText(label, output, expected) {
  invariant(output.includes(expected), `${label} version mismatch: expected output containing ${expected}, got ${output}`);
}

export function loadWasmToolchainLock() {
  return JSON.parse(readFileSync(lockPath, "utf8"));
}

// Verifies the installed toolchain against the platform's lock: every compiler binary by
// hash, every tool by the version and commit it reports, Emscripten by its emsdk commit,
// Rust by its toolchain having rust-src (rustup itself is located but not hashed: it
// installs the toolchain and does not touch the core), and the Naga bridge by its
// Cargo.lock and sources.
//
// With { record: true } the binary hashes are taken from the installed tools instead of
// checked, and written back to the lock; the version, commit and source checks still apply.
// That is how a platform's lock is first filled in (its hashes start as null), and how it is
// re-locked after a deliberate toolchain change.
export function verifyWasmToolchain({ record = false } = {}) {
  const lock = loadWasmToolchainLock();
  invariant(lock.schemaVersion === 1, `Unsupported toolchain lock schema ${lock.schemaVersion}`);
  invariant(platformKey === lock.platform, `Toolchain lock ${lockPath} is for ${lock.platform}, this is ${platformKey}`);
  const recorded = record ? new Map() : null;

  const node = resolveTool("Node", "DOLPHIN_NODE", lock.node.candidates, lock.node.sha256, `node${executableSuffix}`, recorded);
  const emcc = resolveTool("emcc", "EMCC", lock.emscripten.emccCandidates, lock.emscripten.emccSha256, `emcc${scriptSuffix}`, recorded);
  const emcmake = resolveTool("emcmake", "EMCMAKE", lock.emscripten.emcmakeCandidates, lock.emscripten.emcmakeSha256, `emcmake${scriptSuffix}`, recorded);
  const cmake = resolveTool("CMake", "CMAKE", lock.cmake.candidates, lock.cmake.sha256, `cmake${executableSuffix}`, recorded);
  const ninja = resolveTool("Ninja", "NINJA", lock.ninja.candidates, lock.ninja.sha256, `ninja${executableSuffix}`, recorded);
  const rustc = resolveTool("rustc", "RUSTC", lock.rust.rustcCandidates, lock.rust.rustcSha256, null, recorded);
  const cargo = resolveTool("cargo", "CARGO", lock.rust.cargoCandidates, lock.rust.cargoSha256, null, recorded);
  const rustup = resolveTool("rustup", "RUSTUP", lock.rust.rustupCandidates, null, `rustup${executableSuffix}`, recorded, { hashed: false });

  requireText("Node", runVersion(node, ["--version"]), `v${lock.node.version}`);
  const emccVersion = runVersion(emcc, ["--version"]);
  requireText("Emscripten", emccVersion, lock.emscripten.version);
  requireText("Emscripten compiler", emccVersion, lock.emscripten.compilerCommit);
  requireText("CMake", runVersion(cmake, ["--version"]), lock.cmake.version);
  requireText("Ninja", runVersion(ninja, ["--version"]), lock.ninja.version);
  const rustcVersion = runVersion(rustc, ["--version", "--verbose"]);
  requireText("rustc", rustcVersion, lock.rust.rustcVersion);
  requireText("rustc", rustcVersion, lock.rust.rustcCommit);
  const cargoVersion = runVersion(cargo, ["--version", "--verbose"]);
  requireText("cargo", cargoVersion, lock.rust.cargoVersion);
  requireText("cargo", cargoVersion, lock.rust.cargoCommit);

  const emsdkRoot = resolve(dirname(emcc), "../..");
  const emsdkHead = runVersion("git", ["-C", emsdkRoot, "rev-parse", "HEAD"]);
  invariant(emsdkHead === lock.emscripten.emsdkCommit, `emsdk commit mismatch: expected ${lock.emscripten.emsdkCommit}, got ${emsdkHead}`);
  const clangxx = resolve(emsdkRoot, `upstream/bin/clang++${executableSuffix}`);
  invariant(existsSync(clangxx), `Emscripten clang++ is missing at ${clangxx}`);
  if (recorded) {
    recorded.set("clang++", sha256File(clangxx));
  } else {
    invariant(lock.emscripten.clangxxSha256, `Emscripten clang++ has no hash in ${lockPath}; run --record`);
    invariant(sha256File(clangxx) === lock.emscripten.clangxxSha256, "Emscripten clang++ hash mismatch");
  }

  if (lock.rust.rustSrcRequired) {
    const installed = runVersion(rustup, ["component", "list", "--toolchain", lock.rust.toolchain, "--installed"]);
    invariant(installed.split(/\r?\n/).some((line) => line.startsWith("rust-src")), `${lock.rust.toolchain} is missing rust-src`);
  }

  const cargoLock = resolve(root, "tools/naga-spirv-wgsl/Cargo.lock");
  invariant(lock.naga.cargoLockHashMode === "lf-normalized", "Unsupported Naga Cargo.lock hash mode");
  invariant(sha256NormalizedTextFile(cargoLock) === lock.naga.cargoLockSha256, "Naga Cargo.lock hash mismatch");
  const cargoToml = readFileSync(resolve(root, "tools/naga-spirv-wgsl/Cargo.toml"), "utf8");
  invariant(cargoToml.includes(`version = "${lock.naga.crateVersion}"`), "Naga crate version does not match the lock");
  invariant(cargoToml.includes(`naga = { version = "${lock.naga.dependencyVersion.split(".")[0]}"`), "Naga dependency version does not match the lock");
  invariant(Array.isArray(lock.naga.sourceRecords) && lock.naga.sourceRecords.length > 0,
    "Naga source records are missing from the toolchain lock");
  for (const record of lock.naga.sourceRecords) {
    invariant(record.hashMode === "lf-normalized", `Unsupported Naga source hash mode for ${record.path}`);
    const path = resolve(root, record.path);
    invariant(existsSync(path), `Missing Naga source ${record.path}`);
    const bytes = normalizedTextBytes(path);
    invariant(bytes.length === record.size, `Naga source size mismatch for ${record.path}`);
    invariant(createHash("sha256").update(bytes).digest("hex") === record.sha256,
      `Naga source hash mismatch for ${record.path}`);
  }

  if (recorded) {
    lock.node.sha256 = recorded.get("Node");
    lock.emscripten.emccSha256 = recorded.get("emcc");
    lock.emscripten.emcmakeSha256 = recorded.get("emcmake");
    lock.emscripten.clangxxSha256 = recorded.get("clang++");
    lock.cmake.sha256 = recorded.get("CMake");
    lock.ninja.sha256 = recorded.get("Ninja");
    lock.rust.rustcSha256 = recorded.get("rustc");
    lock.rust.cargoSha256 = recorded.get("cargo");
    delete lock.rust.rustupSha256;
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  }

  return {
    lock,
    lockPath,
    recorded: Boolean(recorded),
    paths: { node, emcc, emcmake, cmake, ninja, rustc, cargo, rustup, clangxx },
    hashes: {
      lock: sha256File(lockPath),
      cargoLock: sha256NormalizedTextFile(cargoLock)
    }
  };
}

export { lockPath, sha256File, sha256NormalizedTextFile };
