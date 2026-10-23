// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

// The depth clear values the WebGPU producer sends, and the fallback for cores
// that sent none.
//
// This backend stores reverse-Z window depth: 1 - console depth. The consumer
// clears depth to 0.0 (the console's far, 0xFFFFFF) and flips every depth
// compare. Cores from before vendor patch 0076 gave the consumer no clear depth
// it could use -- BEGIN_PASS carried none, CLEAR_RECT carried the raw console
// value -- so the consumer hard-coded that far clear. Cores from 0076 on send
// the value in the window convention and flag it, so a game that clears to
// anything but far (the console's own reverse-Z trick clears to 0) gets the
// clear it asked for.

// BEGIN_PASS load_op word. Bits 0..2 are the clear enables the consumer always
// decoded; bit 3 says bits 8..31 hold the depth clear as a 24-bit fraction of
// 16777215.
export const BEGIN_PASS_HAS_DEPTH_VALUE = 8;
export const BEGIN_PASS_DEPTH_SHIFT = 8;
export const BEGIN_PASS_DEPTH_SCALE = 16777215;

// CLEAR_RECT flags word. Bits 0..3 are the channel enables; bit 4 says the
// record's depth is in the window convention and is to be written as sent.
export const CLEAR_RECT_DEPTH_IS_WINDOW = 16;

/** Depth clear for a BEGIN_PASS record; `fallback` is the hard-coded far. */
export function beginPassDepthClear(loadOpWord, fallback) {
  const mask = loadOpWord >>> 0;
  if ((mask & BEGIN_PASS_HAS_DEPTH_VALUE) === 0) return fallback;
  return (mask >>> BEGIN_PASS_DEPTH_SHIFT) / BEGIN_PASS_DEPTH_SCALE;
}

/** Depth for a CLEAR_RECT record: its own value when flagged, else `fallback`. */
export function clearRectDepth(flags, recordDepth, fallback) {
  return ((flags >>> 0) & CLEAR_RECT_DEPTH_IS_WINDOW) !== 0 ? recordDepth : fallback;
}
