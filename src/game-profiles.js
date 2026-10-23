// Per-game renderer defaults, derived from measured sweeps of the test library.
//
// Both video paths are correct for most titles but differ enormously in unique
// visual frames, and a handful of games are actively broken on one of them. The
// right default is therefore per-game, not global -- but only where there is
// evidence. Anything absent from this table keeps the shipping default.
//
// Measurement basis: full 45-disc sweeps of both paths on the same machine and
// harness, comparing steady-state unique visual FPS, plus screenshot checks.
// See docs/webgpu-hardware-renderer-bugs.md and docs/perf-results/.
//
// Rules used to build the table, applied conservatively:
//
//   hardware — the frame was CHECKED BY EYE against the software render and is
//              correct, AND the hardware path is materially faster. A large FPS
//              win alone is not enough: a wrong frame can be fast.
//   software — the hardware path is broken for this title, or measurably worse.
//
// Titles with a big FPS win but no verified screenshot are deliberately left
// out. Being absent costs a little speed; being wrong ships a broken picture.
//
// Besides the renderer, an entry can carry what upstream Dolphin knows about
// the title, and what this backend needs to honour it:
//
//   ini      — lines from upstream's Data/Sys/GameSettings/<id>.ini. This build
//              embeds only Sys/Wii, so upstream's per-game settings were never
//              loaded on either path. The worker writes these lines to
//              /dolphin-sys/GameSettings/<id>.ini before boot and Dolphin's own
//              game-config loader applies them. Only [Video_*] sections are
//              carried: a [Core] line such as F-Zero GX's CPUThread=False would
//              silently undo the host's dual-core choice.
//   features — renderer feature bits (RENDERER_FEATURES) the title needs on
//              the hardware path, on top of the defaults. `readback` is the
//              one a title has to earn: it is what makes EFB copies to RAM,
//              EFB peeks and the bounding box real, and each one is a GPU
//              stall, so it is on only where upstream's INI says the game
//              reads its EFB back (EFBToTextureEnable = False, BBoxEnable).
//   test     — what to look at when checking the title by eye on the hardware
//              path, so a re-verification knows what the entry claims.
//
// The ini and features apply whichever renderer runs; the renderer choice is
// the only part the user's explicit ?video= flag overrides.

// Renderer feature mask bits, mirrored from WebGPURendererFeatures.h in the
// vendored backend (patch series). ENABLE polarity. The defaults here are the
// backend's defaults; the host sends the resolved mask on every boot so the
// active configuration is explicit in the status log.
export const RENDERER_FEATURES = Object.freeze({
  // Sub-rect and independent-channel EFB clears as a scissored draw inside the
  // open pass. Mario Kart Wii does not render without it. `?wgpuclearrect=0`.
  scissoredClearRect: Object.freeze({ bit: 1 << 0, default: true, flag: "wgpuclearrect" }),
  // Report no early-Z, so VideoCommon's zcomploc hack runs instead of a
  // FORCE_EARLY_Z that the SPIR-V -> WGSL translation drops. `?wgpuzcomploc=0`.
  zcomplocHack: Object.freeze({ bit: 1 << 1, default: true, flag: "wgpuzcomploc" }),
  // Report no logic ops, so VideoCommon approximates them with blending (plus
  // shader help) instead of the producer doing it after shader generation.
  // `?wgpulogicop=0`.
  logicOpInVideoCommon: Object.freeze({ bit: 1 << 2, default: true, flag: "wgpulogicop" }),
  // GPU -> heap readback for staging textures and the bounding box: EFB copies
  // to RAM, EFB peeks and bbox read real values. Off unless a profile (or
  // `?wgpureadback=1`) asks for it; every readback stalls the video thread
  // until the consumer has mapped the copy.
  readback: Object.freeze({ bit: 1 << 3, default: false, flag: "wgpureadback" }),
  // The depth convention of the cores before vendor patch 0075: they skipped
  // VideoCommon's 1 - x conversions (fog, per-pixel depth, EFB depth copies,
  // EFB peeks/pokes, clear values) for this backend's reverse-Z depth buffer,
  // which inverted exactly the effects 3D gameplay uses. Off by default; on
  // restores that behaviour for an A/B on a title. `?wgpudepthlegacy=1`.
  legacyDepth: Object.freeze({ bit: 1 << 4, default: false, flag: "wgpudepthlegacy" })
});

export const RENDERER_FEATURE_DEFAULT_MASK = Object.values(RENDERER_FEATURES)
  .filter((feature) => feature.default)
  .reduce((mask, feature) => (mask | feature.bit) >>> 0, 0);

/**
 * @typedef {Object} GameProfile
 * @property {"hardware"|"software"} renderer
 * @property {string} why
 * @property {string[]} [ini]      upstream GameSettings lines ([Video_*] only)
 * @property {string} [upstream]   the upstream file those lines come from
 * @property {Partial<Record<keyof typeof RENDERER_FEATURES, boolean>>} [features]
 * @property {string} [test]       what to check by eye on the hardware path
 */

/** @type {Record<string, GameProfile>} */
export const GAME_PROFILES = {
  // --- hardware: verified correct by screenshot, and much faster -----------
  GWWE01: { renderer: "hardware", why: "60 vs 7 fps; throne room verified",
    test: "throne room: full colour, no missing geometry" },
  GFZE01: { renderer: "hardware", why: "60 vs 8 fps; was the software path's worst case",
    // Upstream GFZ.ini also sets [Core] CPUThread=False and FPRF=True; core
    // settings are not carried (see the header), so this is the host's choice.
    test: "name entry and the first race: track, machines, HUD" },
  GM4E01: { renderer: "hardware", why: "60 vs 18 fps; mode select verified",
    test: "mode select, then a race: course, karts, item boxes" },
  GPVE01: { renderer: "hardware", why: "60 vs 10 fps; memory-card screen verified",
    test: "memory-card prompt, then the first area: terrain and Pikmin" },
  GKYE01: { renderer: "hardware", why: "60 vs 10 fps; race scene verified against software",
    test: "a race: green grass (it was pink before the sampler fix)" },
  GLME01: { renderer: "hardware", why: "20.5 vs 6 fps; full colour verified (was sepia pre-fix)",
    test: "mansion interior in full colour, not sepia" },
  GALE01: { renderer: "hardware", why: "60 vs 22 fps; character select verified",
    test: "character select with every portrait; a battle with damage percentages" },

  // --- software: hardware path broken or worse -----------------------------
  GMSE01: {
    renderer: "software",
    why: "an EFB-to-RAM title (upstream GMS.ini) and this backend had no readback: " +
      "the goop maps and EFB peeks read zeros (issue #8); readback is now on for it " +
      "but unverified by eye, so software stays the default",
    upstream: "GMS.ini",
    ini: ["[Video_Hacks]", "EFBToTextureEnable = False", "EFBAccessEnable = True",
      "MissingColorValue = 0x00000000"],
    features: { readback: true },
    test: "file select: the beach behind the file boxes (was white); then Delfino Plaza: " +
      "goop on the ground and the sun's lens flare"
  },
  GCDE08: {
    renderer: "software",
    why: "renders black on hardware; upstream GCD.ini makes it an EFB-to-RAM title " +
      "(EFBToTextureEnable = False) and those copies read back zeros here before readback",
    upstream: "GCD.ini",
    ini: ["[Video_Hacks]", "EFBToTextureEnable = False", "[Video_Settings]",
      "SafeTextureCacheColorSamples = 512"],
    features: { readback: true },
    test: "intro and first room: anything other than black; room transitions"
  },
  GRSEAF: {
    renderer: "software",
    why: "the sweep's 'does not progress' is the autosave dialog waiting for input, " +
      "not a render fault (bug log); 60% game speed on hardware; unverified by eye",
    test: "dismiss the memory-card dialog; character select and a fight"
  },
  GHAE08: {
    renderer: "software",
    why: "'2 vs 17 fps' was measured before the hardware visual-fps metric was fixed " +
      "(issue #7); the later sweep boots it at 100% speed. Pre-rendered backgrounds; " +
      "re-measure before moving it",
    test: "a room with its pre-rendered background and a character on top"
  },
  D43E01: {
    renderer: "software",
    why: "the N64 emulator reads its own EFB copies back (upstream D43.ini: " +
      "EFBToTextureEnable = False); without readback the hardware path showed nothing",
    upstream: "D43.ini",
    ini: ["[Video_Hacks]", "EFBToTextureEnable = False"],
    features: { readback: true },
    test: "title screen and Kokiri Forest: the N64 frame appears and advances"
  },
  G4SE01: {
    renderer: "software",
    why: "12 vs 17 fps was measured before the visual-fps metric was fixed; upstream's " +
      "only hack is texture-cache sampling for CPU-modified textures, now applied on both paths",
    upstream: "G4S.ini",
    ini: ["[Video_Settings]", "SafeTextureCacheColorSamples = 512"],
    test: "title and the first stage: tiles and sprites intact"
  },
  GSAE01: { renderer: "software", why: "79% vs 30% game speed; hardware is 2.6x slower",
    test: "not a correctness entry; speed only" },
  GAFE01: {
    renderer: "software",
    why: "renders black on both paths (issue #11); stay on the shipping path",
    upstream: "GAF.ini",
    ini: ["[Video_Settings]", "SafeTextureCacheColorSamples = 512"],
    test: "not expected to render on either path yet"
  },

  // --- software by default, listed for what upstream says they need --------
  // Absent entries keep the shipping default, so these change nothing about
  // the renderer; they carry upstream's GameSettings and the readback bit so
  // the hardware path can be tried on them with the right configuration.
  PZLE01: {
    renderer: "software",
    why: "Zelda Collector's Edition: the N64 emulator inside reads its EFB copies back " +
      "(upstream PZL.ini); untested on hardware with readback",
    upstream: "PZL.ini",
    ini: ["[Video_Hacks]", "EFBToTextureEnable = False", "ImmediateXFBEnable = False",
      "[Video_Settings]", "SafeTextureCacheColorSamples = 0"],
    features: { readback: true },
    test: "launch one of the N64 games from the menu: its frame appears and advances"
  },
  GZLE01: {
    renderer: "software",
    why: "Wind Waker: EFB-to-RAM and EFB peeks upstream (GZL.ini); 100% speed with 45 " +
      "distinct frames in the hardware sweep, so a hardware candidate once checked by eye",
    upstream: "GZL.ini",
    ini: ["[Video_Hacks]", "EFBAccessEnable = True", "EFBToTextureEnable = False",
      "VISkip = False"],
    features: { readback: true },
    test: "Outset Island: the sun's lens flare when looking at it; the pictograph box; " +
      "the map on the pause screen"
  },
  G8ME01: {
    renderer: "software",
    why: "Paper Mario TTYD: the paper effects need the bounding box and EFB copies to " +
      "RAM (upstream G8M.ini); both read zeros on hardware before readback",
    upstream: "G8M.ini",
    ini: ["[Video_Hacks]", "EFBToTextureEnable = False", "BBoxEnable = True",
      "ImmediateXFBEnable = False", "DeferEFBCopies = False"],
    features: { readback: true },
    test: "the intro and Rogueport: paper-fold transitions and the sprite outlines"
  },
  GPAE01: {
    renderer: "software",
    why: "Pokemon Channel: EFB copies to RAM upstream (GPA.ini); untested on hardware",
    upstream: "GPA.ini",
    ini: ["[Video_Hacks]", "EFBToTextureEnable = False", "[Video_Settings]",
      "SafeTextureCacheColorSamples = 2048"],
    features: { readback: true },
    test: "the television in Pikachu's room shows its programme"
  },
  P2ME01: {
    renderer: "software",
    why: "Metroid Prime 2 bonus disc: EFB copies to RAM upstream (P2M.ini)",
    upstream: "P2M.ini",
    ini: ["[Video_Hacks]", "EFBToTextureEnable = False", "[Video_Settings]",
      "SafeTextureCacheColorSamples = 512"],
    features: { readback: true },
    test: "the demo's first room: visor effects and the scan visor"
  },
  GBZE08: {
    renderer: "software",
    why: "Resident Evil Zero: XFB copies to RAM upstream (GBZ.ini: XFBToTextureEnable = " +
      "False); this host already requests them on the hardware path, and readback makes them real",
    upstream: "GBZ.ini",
    ini: ["[Video_Hacks]", "XFBToTextureEnable = False"],
    features: { readback: true },
    test: "the train: pre-rendered background with the 3D characters on top"
  },

  // Wii. These were briefly defaulted to hardware on a 50-vs-9 fps win with the
  // menus checked by eye. That was wrong twice over. The rendering half of it
  // is now fixed: the scissored ClearRect (0055) and its independent alpha mask
  // (0060) put the world back, and on the deterministic race state the hardware
  // path renders course, kart, signage and HUD pixel-for-pixel against the
  // software reference at a matched emulated frame. What is left is speed --
  // hardware averages ~44% against software's ~100% on that same state -- so
  // software stays the default on performance, not on correctness.
  //
  // Vendor patch 0075 (2026-10-23) then fixed the depth convention that left fog,
  // z-texture depth and EFB depth copies inverted on the hardware path -- the
  // effects 3D gameplay uses and menus do not. It has not been verified by eye on
  // a GPU yet, so both titles stay here until it is; see
  // docs/webgpu-hardware-renderer-bugs.md for what to check.
  RMCE01: {
    renderer: "software",
    why: "44% vs ~100% game speed; hardware renders correctly but is slower",
    // Upstream RMC.ini: EFB format changes. The hardware path's
    // ReinterpretPixelData is still a stub, so this only reaches the software
    // rasteriser, which implements it.
    upstream: "RMC.ini",
    ini: ["[Video_Hacks]", "EFBEmulateFormatChanges = True"],
    test: "Luigi Circuit from the race state: course, kart, signage, HUD"
  },
  SOUE01: {
    renderer: "software",
    why: "hardware unverified in gameplay since the 0075 depth fix",
    upstream: "SOU.ini",
    ini: ["[Video_Hacks]", "EFBAccessEnable = True", "EFBEmulateFormatChanges = True"],
    test: "the field after the title: the world under the HUD, distance blur soft far and sharp near, fog denser with distance"
  }
};

const INI_SECTION = /^\[[A-Za-z_]+\]$/;
const INI_LINE = /^[A-Za-z0-9_]+ = [^\r\n]+$/;

/**
 * The GameSettings INI text for a profile, or null when it carries none.
 *
 * Lines are copied from the profile verbatim after a shape check: only
 * `[Section]` headers and `Key = Value` lines, and only [Video_*] sections,
 * so a profile cannot smuggle a core setting past the policy in the header.
 */
export function gameIniFor(gameId, profile) {
  if (!profile || !Array.isArray(profile.ini) || profile.ini.length === 0) return null;
  const out = [
    `# Written by wasm-dolphin from src/game-profiles.js for ${gameId};`,
    `# mirrors upstream Data/Sys/GameSettings/${profile.upstream ?? "(unspecified)"}`
  ];
  let section = null;
  for (const line of profile.ini) {
    if (INI_SECTION.test(line)) {
      if (!line.startsWith("[Video")) {
        throw new Error(`${gameId}: profile ini may only carry [Video_*] sections, got ${line}`);
      }
      section = line;
    } else if (INI_LINE.test(line)) {
      if (!section) throw new Error(`${gameId}: profile ini line outside a section: ${line}`);
    } else {
      throw new Error(`${gameId}: profile ini line is not "Key = Value": ${line}`);
    }
    out.push(line);
  }
  return `${out.join("\n")}\n`;
}

/**
 * Resolve the renderer feature mask for a boot: the backend defaults, then the
 * profile's `features`, then explicit URL overrides (which always win, so a
 * bisection flag still means what it says on a title with a profile).
 *
 * @param {GameProfile|null} profile
 * @param {Partial<Record<keyof typeof RENDERER_FEATURES, boolean>>} overrides
 */
export function rendererFeatureMask(profile = null, overrides = {}) {
  let mask = RENDERER_FEATURE_DEFAULT_MASK;
  const apply = (name, on) => {
    const feature = RENDERER_FEATURES[name];
    if (!feature) throw new Error(`unknown renderer feature "${name}"`);
    mask = on ? (mask | feature.bit) >>> 0 : (mask & ~feature.bit) >>> 0;
  };
  for (const [name, on] of Object.entries(profile?.features ?? {})) apply(name, Boolean(on));
  for (const [name, on] of Object.entries(overrides ?? {})) {
    if (on === null || on === undefined) continue;
    apply(name, Boolean(on));
  }
  return mask >>> 0;
}

/** Names of the features set in a mask, for status lines. */
export function rendererFeatureNames(mask) {
  return Object.entries(RENDERER_FEATURES)
    .filter(([, feature]) => (mask & feature.bit) !== 0)
    .map(([name]) => name);
}

/**
 * Read renderer feature overrides from a URL query. Each feature has a flag
 * (`?wgpureadback=1`, `?wgpuzcomploc=0`, ...); absent flags are left null so
 * the profile's choice stands.
 */
export function rendererFeatureOverridesFromSearch(search) {
  const params = new URLSearchParams(search ?? "");
  const overrides = {};
  for (const [name, feature] of Object.entries(RENDERER_FEATURES)) {
    const raw = params.get(feature.flag);
    if (raw === null) continue;
    overrides[name] = raw !== "0" && raw !== "false" && raw !== "off";
  }
  return overrides;
}

// Where Dolphin's own game-config loader looks (File::GetSysDirectory() is
// fixed at /dolphin-sys in this build; GAMESETTINGS_DIR = "GameSettings"). The
// loader tries <id>.ini after the shorter 1- and 3-character names, so a file
// named after the full id wins over anything embedded.
export const GAME_SETTINGS_DIR = "/dolphin-sys/GameSettings";

/**
 * Write a profile's INI into the core's filesystem before BootDisc, so
 * upstream's INIGameConfigLayerLoader applies it exactly as desktop Dolphin
 * would apply Sys/GameSettings/<id>.ini. `fs` is Emscripten's FS. Returns
 * whether a file was written; never throws (a failed write is a status line,
 * not a failed mount).
 */
export function writeGameSettingsIni(fs, payload, onStatus = () => {}) {
  if (!fs || !payload?.gameId || typeof payload.ini !== "string" || !payload.ini) return false;
  const path = `${GAME_SETTINGS_DIR}/${payload.gameId}.ini`;
  try {
    for (const dir of ["/dolphin-sys", GAME_SETTINGS_DIR]) {
      try {
        fs.mkdir(dir);
      } catch {
        // Already there (the Wii seed data is embedded under /dolphin-sys).
      }
    }
    fs.writeFile(path, payload.ini);
    onStatus(`${payload.gameId}: wrote ${path} (upstream game settings)`);
    return true;
  } catch (error) {
    onStatus(`${payload.gameId}: could not write ${path}: ${error?.message || error}`);
    return false;
  }
}

/**
 * Everything the worker needs to apply a profile at boot: the id, the INI
 * text to write under /dolphin-sys/GameSettings, and the feature bits.
 */
export function gameProfilePayload(gameId, profile) {
  if (!gameId || !profile) return null;
  return {
    gameId,
    renderer: profile.renderer,
    why: profile.why,
    ini: gameIniFor(gameId, profile),
    features: { ...(profile.features ?? {}) }
  };
}

// Where the GameCube disc header (and so the 6-character game id) sits in each
// container this project accepts. Verified by inspecting real files rather than
// assumed from format docs:
//
//   .iso / .nkit.iso  raw disc image, header at 0
//   .rvz             RVZ container, magic "RVZ\x01", copy of the disc header at 0x58
//   .ciso            CISO container, magic "CISO", 0x8000 header then payload
//
// GCZ and WIA are accepted by the core but are not probed here; they simply get
// no profile, which is the safe outcome.
const ID_PROBES = [
  { offset: 0x0, magic: null },
  { offset: 0x58, magic: { at: 0, bytes: "RVZ" } },
  { offset: 0x8000, magic: { at: 0, bytes: "CISO" } }
];

const ID_PATTERN = /^[A-Z0-9]{6}$/;

function readAscii(buffer, offset, length) {
  const view = new Uint8Array(buffer, offset, length);
  let out = "";
  for (const byte of view) out += String.fromCharCode(byte);
  return out;
}

/**
 * Read the 6-character game id from a disc file without mounting it.
 *
 * This has to happen before the core loads, because the video backend is fixed
 * when the worker starts -- after that, switching means restarting, and the
 * file selection is gone. Reads at most ~32KB from the front of the file.
 *
 * Returns null for anything it cannot identify, which is not an error: the
 * caller falls back to the configured default.
 */
export async function readGameId(file) {
  if (!file || typeof file.slice !== "function") return null;
  try {
    // One read covering every probe offset, rather than several range reads.
    const head = await file.slice(0, 0x8010).arrayBuffer();
    for (const probe of ID_PROBES) {
      if (probe.offset + 6 > head.byteLength) continue;
      if (probe.magic) {
        const seen = readAscii(head, probe.magic.at, probe.magic.bytes.length);
        if (seen !== probe.magic.bytes) continue;
      }
      const id = readAscii(head, probe.offset, 6);
      if (ID_PATTERN.test(id)) return id;
    }
  } catch {
    // Unreadable slice (permissions, zero-length, exotic container): no id.
  }
  return null;
}

/** Profile for a game id, or null when we have no measurement for it. */
export function lookupGameProfile(gameId) {
  if (!gameId) return null;
  return GAME_PROFILES[gameId.toUpperCase()] ?? null;
}
