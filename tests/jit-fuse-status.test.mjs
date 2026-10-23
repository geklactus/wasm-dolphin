import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
const start = source.indexOf("function maybeDisablePpcWasmJit(");
const end = source.indexOf("function normalizePpcWasmJitWarmupFrames(", start);
assert.ok(start >= 0 && end > start, "JIT fuse function must be extractable");
const fuseSource = source.slice(start, end);
const constants = [...fuseSource.matchAll(/\bWASM_JIT_[A-Z_]+\b/g)]
  .map(([name]) => name)
  .filter((name, index, names) => names.indexOf(name) === index)
  .map((name) => {
    const declaration = source.match(new RegExp(`^const ${name} = [^;]+;`, "m"));
    assert.ok(declaration, `missing production threshold ${name}`);
    return declaration[0];
  })
  .join("\n");

function createFuse(overrides = {}) {
  const nativeCalls = [];
  const statuses = [];
  const context = vm.createContext({
    api: {
      getFrame: () => 300,
      setPpcWasmJitEnabled: (mode) => nativeCalls.push(mode),
      getPpcWasmBlockCompileCount: () => overrides.compileCount ?? 0,
    },
    postStatus: (status) => statuses.push(status),
    performance: { now: () => 2000 },
    ppcWasmJitActive: true,
    ppcWasmJitCorePaused: false,
    ppcWasmJitTimingSuspensions: 0,
    ppcWasmJitForce: false,
    ppcWasmJitEnabledAtFrame: 0,
    ppcWasmJitDisabledForSession: false,
    ppcWasmJitCooldownUntilFrame: 0,
    ppcWasmJitFuseLastFrame: 240,
    ppcWasmJitFuseLastTime: 0,
    ppcWasmJitFuseLastCompileCount: 0,
    ppcWasmJitPreEngageCoreFps: 60,
    presentationMaxIntervalMs: 20,
    presentationFps: 57,
    ...overrides,
  });
  vm.runInContext(`${constants}\n${fuseSource}`, context);
  return { context, nativeCalls, statuses, run: () => context.maybeDisablePpcWasmJit() };
}

for (const { reason, baseline, lastFrame } of [
  { reason: "regressed", baseline: 60, lastFrame: 240 },
  { reason: "catastrophic", baseline: 0, lastFrame: 298 },
]) {
  test(`JIT ${reason} fuse reports status and preserves cooldown bookkeeping`, () => {
    const fuse = createFuse({
      ppcWasmJitPreEngageCoreFps: baseline,
      ppcWasmJitFuseLastFrame: lastFrame,
    });

    assert.doesNotThrow(fuse.run);
    assert.deepEqual(fuse.nativeCalls, [0], "disable native JIT exactly once");
    assert.equal(fuse.context.ppcWasmJitActive, false);
    assert.equal(fuse.context.ppcWasmJitDisabledForSession, false);
    assert.equal(fuse.context.ppcWasmJitCooldownUntilFrame, 600);
    assert.equal(fuse.context.ppcWasmJitFuseLastFrame, 300);
    assert.equal(fuse.context.ppcWasmJitFuseLastTime, 2000);
    assert.deepEqual(fuse.statuses, [
      `Experimental WASM JIT temporarily off (fps:57 baseline:${baseline} ${reason}; cooldown 300 frames)`,
    ]);

    fuse.run();
    assert.deepEqual(fuse.nativeCalls, [0], "inactive JIT must not trip again");
    assert.equal(fuse.statuses.length, 1);
  });
}

test("healthy core throughput keeps JIT active even with low presentation FPS", () => {
  const fuse = createFuse({ ppcWasmJitFuseLastFrame: 180, presentationFps: 0 });
  assert.doesNotThrow(fuse.run);
  assert.deepEqual(fuse.nativeCalls, []);
  assert.deepEqual(fuse.statuses, []);
  assert.equal(fuse.context.ppcWasmJitActive, true);
  assert.equal(fuse.context.ppcWasmJitCooldownUntilFrame, 0);
  assert.equal(fuse.context.ppcWasmJitFuseLastFrame, 300);
  assert.equal(fuse.context.ppcWasmJitFuseLastTime, 2000);
});

// §29e: a window the JIT spent compiling fresh blocks is cold code, not a regression
// the JIT caused — the fuse leaves it on and only moves its bookkeeping forward.
test("a compile burst in the window keeps the JIT on", () => {
  for (const [baseline, lastFrame] of [[60, 240], [0, 298]]) {
    const fuse = createFuse({
      ppcWasmJitPreEngageCoreFps: baseline,
      ppcWasmJitFuseLastFrame: lastFrame,
      ppcWasmJitFuseLastCompileCount: 1000,
      compileCount: 1000 + 150,
    });
    assert.doesNotThrow(fuse.run);
    assert.deepEqual(fuse.nativeCalls, []);
    assert.deepEqual(fuse.statuses, []);
    assert.equal(fuse.context.ppcWasmJitActive, true);
    assert.equal(fuse.context.ppcWasmJitFuseLastFrame, 300);
    assert.equal(fuse.context.ppcWasmJitFuseLastCompileCount, 1150);
  }
  // 149 fresh blocks is below the cold-code mark: the regression still counts.
  const fuse = createFuse({ ppcWasmJitFuseLastCompileCount: 1000, compileCount: 1149 });
  fuse.run();
  assert.deepEqual(fuse.nativeCalls, [0]);
});

test("activation grace period defers throughput fuse and its status", () => {
  const fuse = createFuse({ ppcWasmJitEnabledAtFrame: 100, ppcWasmJitFuseLastFrame: 298 });
  assert.doesNotThrow(fuse.run);
  assert.deepEqual(fuse.nativeCalls, []);
  assert.deepEqual(fuse.statuses, []);
  assert.equal(fuse.context.ppcWasmJitActive, true);
  assert.equal(fuse.context.ppcWasmJitCooldownUntilFrame, 0);
  assert.equal(fuse.context.ppcWasmJitFuseLastFrame, 298);
  assert.equal(fuse.context.ppcWasmJitFuseLastTime, 0);
});
