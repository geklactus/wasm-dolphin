// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// A SOURCE-CONTRACT test for the GPU readback path and the honest capability
// flags, in the style of wgpu-clear-rect-source-contract.test.mjs: it reads
// the patched vendor tree and the worker and asserts their shape. It cannot
// show a readback ever lands at runtime; that is the headed check the PR asks
// for per title. What it pins:
//
//   opcode numbers        -> native CmdOp::ReadbackTexture/Buffer == JS constants
//   capability flags      -> bSupportsEarlyZ / bSupportsLogicOp / bSupportsBBox
//                            are read off the renderer feature mask
//   staging readback      -> CopyFromTexture is gated on the readback bit and
//                            publishes the open pass before pushing
//   consumer completion   -> the worker stores the serial and notifies, and
//                            submits the copy immediately
//   loader                -> the worker writes the INI before BootDisc

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const vendor = (path) =>
  new URL(`../vendor/dolphin/Source/Core/VideoBackends/WebGPU/${path}`, import.meta.url);
const workerUrl = new URL("../src/upstream-discio-worker.js", import.meta.url);
const mainThreadUrl = new URL("../src/upstream-main-thread-adapter.js", import.meta.url);

const vendored = existsSync(fileURLToPath(vendor("WebGPURendererFeatures.h")));
const skip = vendored ? false : "vendor/dolphin is not patched; run `npm run patch:upstream` first";
const read = async (url) => (await readFile(url, "utf8")).replaceAll("\r\n", "\n");

test("native and JS agree on the readback opcode numbers", { skip }, async () => {
  const header = await read(vendor("WebGPUCommandStream.h"));
  const worker = await read(workerUrl);
  for (const [native, js] of [
    ["ReadbackTexture", "WGPU_CMD_OP_READBACK_TEXTURE"],
    ["ReadbackBuffer", "WGPU_CMD_OP_READBACK_BUFFER"]
  ]) {
    const n = new RegExp(`${native}\\s*=\\s*(\\d+)\\s*,`).exec(header);
    const j = new RegExp(`const ${js} = (\\d+);`).exec(worker);
    assert.ok(n, `CmdOp::${native} not declared`);
    assert.ok(j, `${js} not declared in the worker`);
    assert.equal(Number(j[1]), Number(n[1]), `${native} opcode differs`);
  }
});

test("the backend's capability flags follow the renderer feature mask", { skip }, async () => {
  const backend = await read(vendor("VideoBackend.cpp"));
  assert.match(backend, /const unsigned int renderer_features = DolphinWeb_GetRendererFeatureMask\(\);/);
  assert.match(
    backend,
    /bSupportsEarlyZ =\s*\n?\s*\(renderer_features & DOLPHIN_WEB_RENDERER_FEATURE_ZCOMPLOC_HACK\) == 0;/
  );
  assert.match(
    backend,
    /bSupportsLogicOp =\s*\n?\s*\(renderer_features & DOLPHIN_WEB_RENDERER_FEATURE_LOGIC_OP_IN_VIDEOCOMMON\) == 0;/
  );
  assert.match(
    backend,
    /bSupportsBBox =\s*\n?\s*\(renderer_features & DOLPHIN_WEB_RENDERER_FEATURE_READBACK\) != 0;/
  );
  assert.doesNotMatch(backend, /bSupportsEarlyZ = true;/, "early-Z must not be claimed unconditionally");
  assert.match(backend, /std::make_unique<WebGPUBoundingBox>\(\)/, "the GPU bounding box is the bbox object");
});

test("the staging texture reads back through the ring only with the feature on", { skip }, async () => {
  const texture = await read(vendor("WebGPUTexture.cpp"));
  const body = texture.slice(texture.indexOf("void WebGPUStagingTexture::CopyFromTexture("));
  assert.match(body, /RendererFeatureEnabled\(DOLPHIN_WEB_RENDERER_FEATURE_READBACK\)/);
  assert.match(body, /gfx->EndPassForImmediateOp\(\);/, "the open pass is published before the copy");
  assert.match(body, /const u32 serial = ArmReadback\(m_flag\);/);
  assert.match(body, /PushReadbackTexture\(/);
  // The wait is bounded: a dead consumer must not hang the video thread.
  const readback = await read(vendor("WebGPUReadback.cpp"));
  assert.match(readback, /kReadbackTimeoutMs = 250\.0;/);
  assert.match(readback, /emscripten_futex_wait\(reinterpret_cast<volatile void\*>\(&flag\.done\), done, kFutexSliceMs\);/);
});

test("the consumer completes every readback it was asked for, served or not", { skip: false }, async () => {
  const worker = await read(workerUrl);
  const tex = worker.slice(worker.indexOf("case WGPU_CMD_OP_READBACK_TEXTURE: {"), worker.indexOf("case WGPU_CMD_OP_READBACK_BUFFER: {"));
  assert.match(tex, /completeReadback\(flagPtr, serial\);\s*\n\s*break;/, "an unserved texture readback is completed at once");
  assert.match(tex, /copyTextureToBuffer\(/);
  assert.match(tex, /submitEnc\("readback"\);/, "the copy is submitted immediately, not at the next present");
  assert.match(tex, /endPass\("readback", read\);/);
  const buf = worker.slice(worker.indexOf("case WGPU_CMD_OP_READBACK_BUFFER: {"), worker.indexOf("case WGPU_CMD_OP_SET_SCISSOR:"));
  assert.match(buf, /copyBufferToBuffer\(buf, srcOffset, slot\.buffer, 0, len\);/);
  assert.match(buf, /submitEnc\("readback"\);/);
  // Completion is the serial the producer armed, stored and notified.
  const complete = worker.slice(worker.indexOf("function completeReadback("), worker.indexOf("function readbackSerialFor("));
  assert.match(complete, /Atomics\.store\(i32, flagPtr >>> 2, serial \| 0\);\s*\n\s*Atomics\.notify\(i32, flagPtr >>> 2\);/);
  assert.match(worker, /Atomics\.load\(i32, \(flagPtr \+ 4\) >>> 2\)/, "the serial is read from flag[1]");
});

test("the INI is written before BootDisc on both adapters", { skip: false }, async () => {
  const worker = await read(workerUrl);
  assert.match(
    worker,
    /writeGameSettingsIni\(fs, gameProfile, postStatus\);\s*\n\s*const _t_boot = performance\.now\(\);\s*\n\s*coreBoot\.accepted = Boolean\(api\.bootDisc\(path\)\);/
  );
  const main = await read(mainThreadUrl);
  assert.match(
    main,
    /writeGameSettingsIni\(fs, this\.gameProfile, this\.onStatus\);\s*\n\s*this\.coreBoot\.accepted = Boolean\(this\.api\.bootDisc\(path\)\);/
  );
});
