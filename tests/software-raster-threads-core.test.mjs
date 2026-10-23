// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Band-parallel software rasterizer parity, run against the committed core in Node.
//
// The core exports a smoke (core/upstream/dolphin_web_core.cpp,
// SoftwareRasterThreadsSmoke*) that drives Rasterizer directly with a deterministic
// synthetic scene: no disc, no FIFO, no vertex loader. The scene mixes triangle sizes,
// off-screen and scissor-clipped triangles, culled-only z-slope updates, zfreeze on and
// off, early and late depth testing and colour-write-disabled batches. The EFB hash must be
// byte-identical whatever worker count was requested; that is the whole claim of
// docs/software-raster-threads.md, and this is where it is checked without a game.
//
// Each fastsw mode is a separate module instance: Rasterizer::Draw latches the mode on its
// first pixel (the smoke's Init refuses a different mode later, so a mix-up fails loudly). The
// pthread pool is pre-spawned (16 workers), so starting the raster workers needs no event-loop
// turn, but their first instruction is asynchronous; the test waits for the started count
// before drawing so the workers really take part.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const coreJs = new URL("../cores/dolphin/dolphin-core-upstream.js", import.meta.url);
const coreWasm = new URL("../cores/dolphin/dolphin-core-upstream.wasm", import.meta.url);

const SEEDS = [1, 2, 3];
const BATCHES = 48;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadCore(fastSoftwareRaster) {
  const { default: createDolphinCore } = await import(coreJs);
  const module = await createDolphinCore({
    wasmBinary: readFileSync(coreWasm),
    noInitialRun: true,
    dolphinFastSoftwareRaster: fastSoftwareRaster
  });
  return {
    module,
    fastSoftwareRaster,
    init: module.cwrap("SoftwareRasterThreadsSmokeInit", "number", ["number", "number"]),
    started: module.cwrap("SoftwareRasterThreadsSmokeStarted", "number", []),
    run: module.cwrap("SoftwareRasterThreadsSmokeRun", "number", ["number", "number"]),
    workerBands: module.cwrap("SoftwareRasterThreadsSmokeWorkerBands", "number", []),
    shutdown: module.cwrap("SoftwareRasterThreadsSmokeShutdown", "number", [])
  };
}

async function startWorkers(core, workers) {
  assert.equal(
    core.init(workers, core.fastSoftwareRaster),
    workers,
    `Rasterizer::Init should start ${workers} workers`
  );
  const deadline = Date.now() + 10000;
  while (core.started() < workers) {
    assert.ok(Date.now() < deadline, `only ${core.started()} of ${workers} raster workers started`);
    await sleep(20);
  }
}

for (const fastsw of [0, 1, 2]) {
  test(`software raster threads draw the same EFB as one thread (fastsw=${fastsw})`, async (t) => {
    if (!existsSync(coreJs) || !existsSync(coreWasm)) {
      t.skip("upstream full core has not been built");
      return;
    }

    const core = await loadCore(fastsw);
    try {
      await startWorkers(core, 0);
      const single = SEEDS.map((seed) => core.run(seed, BATCHES) >>> 0);
      // The scene is not empty and differs between seeds.
      assert.equal(new Set(single).size, SEEDS.length);

      // Repeating a seed on one thread is deterministic.
      assert.equal(core.run(SEEDS[0], BATCHES) >>> 0, single[0]);

      assert.equal(core.workerBands(), 0, "no worker bands with zero workers");

      for (const workers of [1, 3]) {
        await startWorkers(core, workers);
        for (const [index, seed] of SEEDS.entries()) {
          assert.equal(
            core.run(seed, BATCHES) >>> 0,
            single[index],
            `seed ${seed} with ${workers} worker(s) must match the single-threaded EFB`
          );
        }
        // The parity above is only evidence if the workers actually drew bands: every fourth
        // batch of the scene is large enough to go parallel, and bands are claimed dynamically.
        assert.ok(
          core.workerBands() > 0,
          `workers should have drawn bands with ${workers} worker(s), got ${core.workerBands()}`
        );
      }
    } finally {
      assert.equal(core.shutdown(), 0);
    }
  });
}
