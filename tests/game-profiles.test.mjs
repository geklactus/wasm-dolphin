// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// The per-game profile table is policy: which renderer a title gets, which of
// upstream's GameSettings lines it carries, and which renderer feature bits it
// turns on. These tests pin the shape of that policy and the two things that
// make it bite -- the INI text the worker writes for Dolphin's own loader, and
// the feature mask the core receives -- against the vendored backend's bit
// definitions when the tree is patched.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  GAME_PROFILES,
  GAME_SETTINGS_DIR,
  RENDERER_FEATURES,
  RENDERER_FEATURE_DEFAULT_MASK,
  gameIniFor,
  gameProfilePayload,
  lookupGameProfile,
  rendererFeatureMask,
  rendererFeatureNames,
  rendererFeatureOverridesFromSearch,
  writeGameSettingsIni
} from "../src/game-profiles.js";

const featuresHeaderUrl = new URL(
  "../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPURendererFeatures.h",
  import.meta.url
);

test("every profile has a 6-character id, a renderer and a reason", () => {
  for (const [id, profile] of Object.entries(GAME_PROFILES)) {
    assert.match(id, /^[A-Z0-9]{6}$/, `${id} is not a game id`);
    assert.ok(["hardware", "software"].includes(profile.renderer), `${id}: renderer`);
    assert.ok(typeof profile.why === "string" && profile.why.length > 0, `${id}: why`);
    for (const name of Object.keys(profile.features ?? {})) {
      assert.ok(name in RENDERER_FEATURES, `${id}: unknown feature ${name}`);
    }
  }
  assert.equal(lookupGameProfile("gmse01")?.renderer, "software", "lookup is case-insensitive");
  assert.equal(lookupGameProfile("ZZZZ99"), null);
  assert.equal(lookupGameProfile(null), null);
});

test("hardware entries say what to check by eye", () => {
  for (const [id, profile] of Object.entries(GAME_PROFILES)) {
    if (profile.renderer !== "hardware") continue;
    assert.ok(typeof profile.test === "string" && profile.test.length > 0, `${id}: test`);
  }
});

test("the default feature mask is the backend's: ClearRect, zcomploc hack, logic op; no readback", () => {
  assert.equal(RENDERER_FEATURE_DEFAULT_MASK, 0b0111);
  assert.equal(RENDERER_FEATURES.readback.default, false);
  assert.deepEqual(rendererFeatureNames(RENDERER_FEATURE_DEFAULT_MASK), [
    "scissoredClearRect",
    "zcomplocHack",
    "logicOpInVideoCommon"
  ]);
  assert.equal(rendererFeatureMask(null), RENDERER_FEATURE_DEFAULT_MASK);
});

test("a profile's features are added to the defaults and URL overrides win", () => {
  const sunshine = GAME_PROFILES.GMSE01;
  assert.equal(rendererFeatureMask(sunshine), 0b1111, "Sunshine turns readback on");
  assert.equal(rendererFeatureMask(sunshine, { readback: false }), 0b0111, "?wgpureadback=0 wins");
  assert.equal(rendererFeatureMask(null, { readback: true }), 0b1111, "?wgpureadback=1 without a profile");
  assert.equal(rendererFeatureMask(null, { zcomplocHack: false }), 0b0101);
  assert.equal(rendererFeatureMask(null, { scissoredClearRect: false }), 0b0110);
  assert.equal(rendererFeatureMask(null, { readback: null }), 0b0111, "null is 'not set'");
  assert.throws(() => rendererFeatureMask({ features: { nope: true } }), /unknown renderer feature/);
});

test("URL flags map to feature overrides", () => {
  assert.deepEqual(rendererFeatureOverridesFromSearch(""), {});
  assert.deepEqual(rendererFeatureOverridesFromSearch("?wgpureadback=1&wgpuzcomploc=0"), {
    readback: true,
    zcomplocHack: false
  });
  assert.deepEqual(rendererFeatureOverridesFromSearch("?wgpulogicop=off&wgpuclearrect=false"), {
    logicOpInVideoCommon: false,
    scissoredClearRect: false
  });
});

test("the INI text carries only [Video_*] sections, as Key = Value lines", () => {
  const text = gameIniFor("GMSE01", GAME_PROFILES.GMSE01);
  assert.match(text, /^# Written by wasm-dolphin from src\/game-profiles\.js for GMSE01;\n/);
  assert.match(text, /mirrors upstream Data\/Sys\/GameSettings\/GMS\.ini\n/);
  assert.match(text, /\n\[Video_Hacks\]\nEFBToTextureEnable = False\nEFBAccessEnable = True\n/);
  assert.ok(text.endsWith("\n"));
  assert.equal(gameIniFor("GWWE01", GAME_PROFILES.GWWE01), null, "no ini, no file");

  // Core settings are refused: F-Zero GX's upstream CPUThread = False would
  // silently undo the host's dual-core choice.
  assert.throws(
    () => gameIniFor("GFZE01", { renderer: "hardware", why: "x", ini: ["[Core]", "CPUThread = False"] }),
    /only carry \[Video_\*\] sections/
  );
  assert.throws(
    () => gameIniFor("X", { renderer: "software", why: "x", ini: ["EFBToTextureEnable = False"] }),
    /outside a section/
  );
  assert.throws(
    () => gameIniFor("X", { renderer: "software", why: "x", ini: ["[Video_Hacks]", "$Cheat"] }),
    /not "Key = Value"/
  );
  for (const [id, profile] of Object.entries(GAME_PROFILES)) gameIniFor(id, profile);
});

test("readback is only granted where upstream says the game reads its EFB back", () => {
  // The profile policy: a title earns the readback bit by an upstream INI line
  // that makes VideoCommon read the EFB or XFB back into RAM, or by needing the
  // bounding box. Nothing else justifies a per-copy GPU stall.
  const justifications = [
    "EFBToTextureEnable = False",
    "XFBToTextureEnable = False",
    "BBoxEnable = True"
  ];
  for (const [id, profile] of Object.entries(GAME_PROFILES)) {
    if (!profile.features?.readback) continue;
    const lines = profile.ini ?? [];
    assert.ok(
      justifications.some((line) => lines.includes(line)),
      `${id} turns readback on without an upstream line that needs it`
    );
    assert.ok(profile.upstream, `${id}: readback entries name their upstream INI`);
  }
});

test("the payload the worker receives names the id, the INI text and the features", () => {
  const payload = gameProfilePayload("GCDE08", GAME_PROFILES.GCDE08);
  assert.equal(payload.gameId, "GCDE08");
  assert.equal(payload.renderer, "software");
  assert.match(payload.ini, /\[Video_Settings\]\nSafeTextureCacheColorSamples = 512\n/);
  assert.deepEqual(payload.features, { readback: true });
  assert.equal(gameProfilePayload("GCDE08", null), null);
  assert.equal(gameProfilePayload(null, GAME_PROFILES.GCDE08), null);
});

test("writeGameSettingsIni writes <id>.ini where Dolphin's loader looks, and never throws", () => {
  const calls = [];
  const fs = {
    mkdir(path) {
      calls.push(["mkdir", path]);
      if (path === "/dolphin-sys") throw new Error("EEXIST");
    },
    writeFile(path, data) {
      calls.push(["writeFile", path, data]);
    }
  };
  const status = [];
  const payload = gameProfilePayload("D43E01", GAME_PROFILES.D43E01);
  assert.equal(writeGameSettingsIni(fs, payload, (line) => status.push(line)), true);
  assert.deepEqual(calls.map((c) => c.slice(0, 2)), [
    ["mkdir", "/dolphin-sys"],
    ["mkdir", GAME_SETTINGS_DIR],
    ["writeFile", `${GAME_SETTINGS_DIR}/D43E01.ini`]
  ]);
  assert.equal(calls[2][2], payload.ini);
  assert.match(status[0], /D43E01: wrote \/dolphin-sys\/GameSettings\/D43E01\.ini/);

  assert.equal(writeGameSettingsIni(fs, null), false);
  assert.equal(writeGameSettingsIni(fs, { gameId: "GWWE01", ini: null }), false);
  const broken = { mkdir() {}, writeFile() { throw new Error("EROFS"); } };
  const errors = [];
  assert.equal(writeGameSettingsIni(broken, payload, (line) => errors.push(line)), false);
  assert.match(errors[0], /could not write .*EROFS/);
});

test("the feature bits match the vendored backend's definitions", {
  skip: existsSync(fileURLToPath(featuresHeaderUrl))
    ? false
    : "vendor/dolphin is not patched; run `npm run patch:upstream` first"
}, async () => {
  const header = (await readFile(featuresHeaderUrl, "utf8")).replaceAll("\r\n", "\n");
  const expected = {
    scissoredClearRect: "SCISSORED_CLEAR_RECT",
    zcomplocHack: "ZCOMPLOC_HACK",
    logicOpInVideoCommon: "LOGIC_OP_IN_VIDEOCOMMON",
    readback: "READBACK"
  };
  for (const [name, feature] of Object.entries(RENDERER_FEATURES)) {
    const re = new RegExp(`DOLPHIN_WEB_RENDERER_FEATURE_${expected[name]}\\s*=\\s*1u\\s*<<\\s*(\\d+)\\s*;`);
    const m = re.exec(header);
    assert.ok(m, `${name}: bit not declared in WebGPURendererFeatures.h`);
    assert.equal(1 << Number(m[1]), feature.bit, `${name}: bit value differs from the header`);
  }
  const dflt = /DOLPHIN_WEB_RENDERER_FEATURE_DEFAULT\s*=\s*([^;]+);/.exec(header);
  assert.ok(dflt);
  let mask = 0;
  for (const [name, feature] of Object.entries(RENDERER_FEATURES)) {
    if (dflt[1].includes(`DOLPHIN_WEB_RENDERER_FEATURE_${expected[name]}`)) mask |= feature.bit;
  }
  assert.equal(mask, RENDERER_FEATURE_DEFAULT_MASK, "the JS default must equal the C++ default");
});
