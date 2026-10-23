// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import {
  BEGIN_PASS_HAS_DEPTH_VALUE,
  CLEAR_RECT_DEPTH_IS_WINDOW,
  beginPassDepthClear,
  clearRectDepth,
} from "../src/wgpu-depth-clear.js";

// The producer packs round(depth * 16777215) into bits 8..31 of the load_op
// word, above the three clear-enable bits the consumer always decoded.
function loadOpWord(enables, depth) {
  return (enables | BEGIN_PASS_HAS_DEPTH_VALUE | (Math.round(depth * 16777215) << 8)) >>> 0;
}

test("BEGIN_PASS without a depth value keeps the consumer's hard-coded far clear", () => {
  for (const legacyWord of [0, 1, 3, 5, 7]) {
    assert.equal(beginPassDepthClear(legacyWord, 0.0), 0.0);
    assert.equal(beginPassDepthClear(legacyWord, 1.0), 1.0);
  }
});

test("BEGIN_PASS with a depth value decodes it exactly at both ends of the range", () => {
  // The console's far (0xFFFFFF) in the reverse-Z window convention.
  assert.equal(beginPassDepthClear(loadOpWord(7, 0.0), 0.5), 0.0);
  // The console's reverse-Z trick clears to 0, which this backend stores as 1.0.
  assert.equal(beginPassDepthClear(loadOpWord(7, 1.0), 0.5), 1.0);
  // The usual 1 - 0xFFFFFF/2^24 lands within one 24-bit step of zero.
  const nearZero = beginPassDepthClear(loadOpWord(7, 1 - 0xffffff / 16777216), 0.5);
  assert.ok(nearZero >= 0 && nearZero < 2 / 16777215, `got ${nearZero}`);
  // An intermediate clear survives the 24-bit quantisation to well under a
  // depth-buffer step.
  const mid = beginPassDepthClear(loadOpWord(7, 0.25), 0.5);
  assert.ok(Math.abs(mid - 0.25) < 1 / 16777215, `got ${mid}`);
});

test("BEGIN_PASS clear enables are untouched by the packed depth", () => {
  const word = loadOpWord(5, 0.75);
  assert.equal(word & 1, 1, "clear-any bit");
  assert.equal(word & 2, 0, "colour not cleared");
  assert.equal(word & 4, 4, "depth cleared");
  assert.notEqual(word, 1, "never reads as the legacy clear-both word");
});

test("CLEAR_RECT uses the record's depth only when the producer flags it", () => {
  assert.equal(clearRectDepth(3, 0.25, 0.0), 0.0, "unflagged: hard-coded far");
  assert.equal(clearRectDepth(3 | CLEAR_RECT_DEPTH_IS_WINDOW, 0.25, 0.0), 0.25);
  assert.equal(clearRectDepth(15 | CLEAR_RECT_DEPTH_IS_WINDOW, 1.0, 0.0), 1.0);
  assert.equal(clearRectDepth(2 | CLEAR_RECT_DEPTH_IS_WINDOW, 0.0, 1.0), 0.0);
});
