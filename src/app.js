import { gameProfilePayload, lookupGameProfile, readGameId } from "./game-profiles.js";
import { AudioController } from "./audio.js";
import {
  DEFAULT_WIIMOTE_MOUSE_BINDINGS,
  cursorFromPointer,
  readWiimoteFromGamepad,
  resolveWiimoteKey,
  wiimoteStateFromInputs
} from "./wiimote.js";
import { EmulatorHost } from "./core-host.js";
import { startMainThreadProfiler } from "./main-profiler.js";
import { createCausalTelemetry, deepMerge } from "./causal-telemetry.js";
import {
  CONTROL_LABELS,
  formatControlLabel,
  gamepadInputsEqual,
  inputStateFromPressed,
  mergePressedSets,
  readGamepadInput,
  resolveKeyboardButton,
  selectPreferredGamepad,
  updatePressedSet
} from "./input.js";
import {
  buildPlayablePresetHref,
  buildSettingsHref,
  describeSettings,
  readSettingsFromSearch
} from "./settings.js";
import {
  requestedWgpuRendererWorkerProbe,
  shouldShowIntentionalBlankWgpuNotice
} from "./wgpu-replay-diagnostics.js";
import {
  discCacheKey,
  formatDiscBytes,
  listCachedDiscs,
  readCachedDiscEntry,
  readCachedRange,
  readRemoteDiscFlags,
  removeCachedDisc
} from "./remote-disc.js";

const elements = {
  panelToggle: document.querySelector("#panelToggle"),
  controlPanel: document.querySelector("#controlPanel"),
  volumeDial: document.querySelector("#volumeDial"),
  aspectSelect: document.querySelector("#aspectSelect"),
  autoProfile: document.querySelector("#settingAutoProfile"),
  lcdTitle: document.querySelector("#lcdTitle"),
  lcdMeta: document.querySelector("#lcdMeta"),
  adapterStatus: document.querySelector("#adapterStatus"),
  audioStatus: document.querySelector("#audioStatus"),
  bootApploader: document.querySelector("#bootApploader"),
  bootBlocker: document.querySelector("#bootBlocker"),
  bootDol: document.querySelector("#bootDol"),
  bootEntry: document.querySelector("#bootEntry"),
  bootFst: document.querySelector("#bootFst"),
  bootImage: document.querySelector("#bootImage"),
  bootStatus: document.querySelector("#bootStatus"),
  blankProbeNotice: document.querySelector("#blankProbeNotice"),
  controlGrid: document.querySelector("#controlGrid"),
  coreLabel: document.querySelector("#coreLabel"),
  coreMode: document.querySelector("#coreMode"),
  debugPanel: document.querySelector("#debugPanel"),
  debugToggle: document.querySelector("#debugToggle"),
  discCache: document.querySelector("#discCache"),
  discCacheNote: document.querySelector("#discCacheNote"),
  discDownloadFirst: document.querySelector("#discDownloadFirst"),
  discLibrary: document.querySelector("#discLibrary"),
  discLibraryList: document.querySelector("#discLibraryList"),
  discLibraryTotal: document.querySelector("#discLibraryTotal"),
  discNetNote: document.querySelector("#discNetNote"),
  discReadsButton: document.querySelector("#discReadsButton"),
  discRemoveButton: document.querySelector("#discRemoveButton"),
  dropBadge: document.querySelector("#dropBadge"),
  dropZone: document.querySelector("#dropZone"),
  frameCounter: document.querySelector("#frameCounter"),
  fullscreenButton: document.querySelector("#fullscreenButton"),
  fpsCounter: document.querySelector("#fpsCounter"),
  visualFpsCounter: document.querySelector("#visualFpsCounter"),
  gameSpeedCounter: document.querySelector("#gameSpeedCounter"),
  coreTicks: document.querySelector("#coreTicks"),
  coreFpsCounter: document.querySelector("#coreFpsCounter"),
  presentationGapCounter: document.querySelector("#presentationGapCounter"),
  presentationLagCounter: document.querySelector("#presentationLagCounter"),
  ppcPc: document.querySelector("#ppcPc"),
  cpuCoreName: document.querySelector("#cpuCoreName"),
  ppcWasmJit: document.querySelector("#ppcWasmJit"),
  ppcWasmHelperStats: document.querySelector("#ppcWasmHelperStats"),
  frameProfileStats: document.querySelector("#frameProfileStats"),
  uiFpsCounter: document.querySelector("#uiFpsCounter"),
  gameSize: document.querySelector("#gameSize"),
  gameTitle: document.querySelector("#gameTitle"),
  hudFps: document.querySelector("#hudFps"),
  hudJit: document.querySelector("#hudJit"),
  hudLatency: document.querySelector("#hudLatency"),
  hudResolution: document.querySelector("#hudResolution"),
  hudSpeed: document.querySelector("#hudSpeed"),
  hudVisualFps: document.querySelector("#hudVisualFps"),
  hudCoreFps: document.querySelector("#hudCoreFps"),
  hudFrame: document.querySelector("#hudFrame"),
  hudGlSwap: document.querySelector("#hudGlSwap"),
  hudMode: document.querySelector("#hudMode"),
  hudWatchdog: document.querySelector("#hudWatchdog"),
  hudGap: document.querySelector("#hudGap"),
  hudGlError: document.querySelector("#hudGlError"),
  hudDraw: document.querySelector("#hudDraw"),
  hudNz: document.querySelector("#hudNz"),
  hudUnderDrop: document.querySelector("#hudUnderDrop"),
  hudQueue: document.querySelector("#hudQueue"),
  hudJitCache: document.querySelector("#hudJitCache"),
  hudRunloop: document.querySelector("#hudRunloop"),
  hudWgx: document.querySelector("#hudWgx"),
  hudStatus: document.querySelector("#hudStatus"),
  inputSource: document.querySelector("#inputSource"),
  loadButton: document.querySelector("#loadButton"),
  dlStateButton: document.querySelector("#dlStateButton"),
  ulStateInput: document.querySelector("#ulStateInput"),
  mountNote: document.querySelector("#mountNote"),
  muteButton: document.querySelector("#muteButton"),
  overlayToggle: document.querySelector("#overlayToggle"),
  resetButton: document.querySelector("#resetButton"),
  romInput: document.querySelector("#romInput"),
  rootEntryList: document.querySelector("#rootEntryList"),
  runButton: document.querySelector("#runButton"),
  saveButton: document.querySelector("#saveButton"),
  screen: document.querySelector("#screen"),
  screenHud: document.querySelector("#screenHud"),
  settingCore: document.querySelector("#settingCore"),
  settingCpu: document.querySelector("#settingCpu"),
  settingFastSw: document.querySelector("#settingFastSw"),
  settingSwThreads: document.querySelector("#settingSwThreads"),
  settingForceJit: document.querySelector("#settingForceJit"),
  settingJitTier: document.querySelector("#settingJitTier"),
  settingOglProxy: document.querySelector("#settingOglProxy"),
  settingPacing: document.querySelector("#settingPacing"),
  settingMetrics: document.querySelector("#settingMetrics"),
  settingPresenter: document.querySelector("#settingPresenter"),
  settingQueue: document.querySelector("#settingQueue"),
  settingResolution: document.querySelector("#settingResolution"),
  settingSpeed: document.querySelector("#settingSpeed"),
  settingVideo: document.querySelector("#settingVideo"),
  settingWasmJit: document.querySelector("#settingWasmJit"),
  settingsApplyButton: document.querySelector("#settingsApplyButton"),
  settingsForm: document.querySelector("#settingsForm"),
  settingsPresetButton: document.querySelector("#settingsPresetButton"),
  settingsSummary: document.querySelector("#settingsSummary"),
  statusPill: document.querySelector("#statusPill")
};

const DEBUG_PREF_KEY = "wasm-dolphin.debug-open";
const OSD_PREF_KEY = "wasm-dolphin.osd-visible";

// ?disc= state (wireRemoteDisc() runs from the wire* calls below, before the rest of
// this module has been evaluated, so what it touches is declared up here).
const DISC_PERSIST_ASKED_KEY = "wasm-dolphin.disc-persist-asked";
const DISC_DOWNLOAD_FIRST_KEY = "wasm-dolphin.disc-download-first";
const remoteDiscState = { disc: null, key: null, stats: null, poll: null, libraryAt: 0, complete: false };

class RemoteDisc {
  constructor(source) {
    Object.assign(this, source);
    this.type = "application/octet-stream";
  }

  // The header read before any worker exists: from this device's copy when it holds
  // those bytes (a second launch reads nothing from the network), else a Range request.
  slice(start = 0, end = this.size) {
    const source = { url: this.url, name: this.name, size: this.size, etag: this.etag, lastModified: this.lastModified };
    const stop = Math.min(end, this.size);
    const local = this.opfs;
    return {
      arrayBuffer: async () => {
        const cached = local ? await opfsRoot().then((root) => readCachedRange(root, source, start, stop)).catch(() => null) : null;
        if (cached) return cached.buffer;
        const response = await fetch(source.url, {
          headers: { Range: `bytes=${start}-${stop - 1}` },
          credentials: "same-origin",
          cache: "no-store"
        });
        if (response.status !== 206) throw new Error(`the disc answered HTTP ${response.status} to a Range request`);
        return response.arrayBuffer();
      }
    };
  }
}

let opfsRootPromise = null;
function opfsRoot() {
  if (!navigator.storage?.getDirectory) return Promise.resolve(null);
  opfsRootPromise ??= navigator.storage.getDirectory().catch(() => null);
  return opfsRootPromise;
}

const keyboardPressed = new Set();
let touchPressed = new Set();
let gamepadPressed = new Set();
let gamepadInputState = null;
let lastGamepadInput = null;
let combinedPressed = new Set();
// Wii Remote 1: what the keyboard, the mouse and a gamepad currently say (src/wiimote.js).
const wiimoteKeys = new Set();
const wiimoteMouseButtons = new Set();
let wiimoteCursor = null;
let wiimoteGamepad = null;
let lastFrameInfo = null;
let lastCausalTelemetry = null;
let lastCausalTelemetryCapturedAt = -1;
let currentSettings = readSettingsFromSearch(window.location.search);
const requestedWgpuProbe = requestedWgpuRendererWorkerProbe(window.location.search);

if (elements.blankProbeNotice && shouldShowIntentionalBlankWgpuNotice(window.location.search)) {
  elements.blankProbeNotice.hidden = false;
  elements.blankProbeNotice.textContent =
    `Intentional blank diagnostic: ${requestedWgpuProbe}. Remove wgpurenderprobe to render game output.`;
}

const audio = new AudioController();
// Exposed for the validator: lets it unmute programmatically and tap the
// AudioContext via an AnalyserNode to check that audio is actually being
// produced during gameplay (Phase C of the smoothness/audio validator).
window.__audio = audio;
const host = new EmulatorHost({
  canvas: elements.screen,
  onFrame: handleFrame,
  onStatus: setStatus,
  onMode: setMode
});
audio.setSource((frames) => host.mixAudio(frames));
audio.setTransportBridge((config) => host.configureAudioWorklet(config));
// §28cx: expose the host so the main-thread profiler can read the existing
// >20ms stall counters (rAF loop vs worker→main message handler). LoAF's
// 50ms floor is blind to the 33-50ms band that actually starves the audio
// pump; these counters cover >20ms and attribute it to JS vs non-JS.
window.__host = host;

// Validator/dev hook: fetch a Dolphin .sav by URL and State::LoadAs it
// through the active adapter (worker → core LoadStateFile). Returns the
// worker response ({loaded, rc, beforeState, afterState}) so callers
// can tell a successful load from a build/version rejection.
window.__loadStateFile = async (url) => {
  try {
    const res = await fetch(url);
    if (!res.ok) return { loaded: false, error: `fetch ${res.status}` };
    const bytes = new Uint8Array(await res.arrayBuffer());
    const a = host.adapter;
    if (!a || typeof a.loadStateFile !== "function")
      return { loaded: false, error: "adapter has no loadStateFile" };
    return await a.loadStateFile(bytes);
  } catch (e) {
    return { loaded: false, error: String(e?.message || e) };
  }
};

// Capture a version-matched save state from THIS build; returns it
// base64-encoded so the validator can persist it (Playwright evaluate
// can't return an ArrayBuffer). Chunked to avoid call-stack limits.
window.__saveStateFile = async () => {
  try {
    const a = host.adapter;
    if (!a || typeof a.saveStateFile !== "function")
      return { saved: false, error: "adapter has no saveStateFile" };
    const r = await a.saveStateFile();
    if (!r || !r.bytes) return { saved: false, error: r?.error || "no bytes" };
    const u8 = new Uint8Array(r.bytes);
    let bin = "";
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH)
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return { saved: r.saved, size: r.size, b64: btoa(bin) };
  } catch (e) {
    return { saved: false, error: String(e?.message || e) };
  }
};

// One-call: capture a version-matched state and download it as a
// .sav file from the browser. Run window.__downloadSaveState() in the
// devtools console while in the battle scene. The downloaded file is
// loadable by this exact build via the validator's SAVE_STATE_URL.
window.__downloadSaveState = async (name) => {
  try {
    const a = host.adapter;
    if (!a || typeof a.saveStateFile !== "function")
      return { saved: false, error: "adapter has no saveStateFile" };
    const r = await a.saveStateFile();
    if (!r || !r.bytes) return { saved: false, error: r?.error || "no bytes" };
    const blob = new Blob([r.bytes], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name || "battle-state.sav";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return { saved: true, size: r.size, file: link.download };
  } catch (e) {
    return { saved: false, error: String(e?.message || e) };
  }
};

// Reload a state already in the worker FS (round-trip proof).
window.__loadStateFileFs = async (fsPath) => {
  try {
    const a = host.adapter;
    if (!a || typeof a.loadStateFileFromFs !== "function")
      return { loaded: false, error: "adapter has no loadStateFileFromFs" };
    return await a.loadStateFileFromFs(fsPath || "/savestate_out.sav");
  } catch (e) {
    return { loaded: false, error: String(e?.message || e) };
  }
};

renderControlGrid();
wireSettings();
wireDiagnostics();
wirePanelToggle();
wireVolumeDial();
wireAspectSelect();
wireScreenFit();
wireFileMounting();
wireTransport();
wireKeyboard();
wireWiimotePointer();
wireTouchControls();
wireGamepadPolling();
wireRemoteDisc();

// §28cx main-thread profiler — activates only with ?mainprof=1. Diagnoses
// what eats main-thread time (LoAF script attribution) and whether the audio
// pump's setInterval is being starved, the suspected cause of real-Chrome
// audio underruns the worker-only probe can't see.
startMainThreadProfiler();

host
  .init()
  .then(runSmokeScenario)
  .catch((error) => {
    setStatus(error.message, "error");
  });

function handleFrame(info) {
  if (
    info.causalTelemetry &&
    info.causalTelemetry.capturedAtMs !== lastCausalTelemetryCapturedAt
  ) {
    lastCausalTelemetry = createCausalTelemetry(deepMerge(info.causalTelemetry, {
      audio: audio.causalTelemetry()
    }));
    lastCausalTelemetryCapturedAt = info.causalTelemetry.capturedAtMs;
  }
  if (lastCausalTelemetry) info.causalTelemetry = lastCausalTelemetry;
  lastFrameInfo = info;
  // Expose to the validator. Reading via window is cheaper than DOM
  // querySelector + textContent parsing and preserves structured
  // numeric fields (histogram array, stddev) without round-tripping
  // through human-readable strings.
  window.__lastFrameInfo = info;
  window.__causalTelemetry = info.causalTelemetry || null;
  updateScreenHud(info);
  updateRuntimeControls(info);

  if (!elements.debugPanel.hidden) {
    updateDebugMetrics(info);
  }
}

function updateRuntimeControls(info) {
  elements.coreMode.textContent = info.mode === "dolphin" ? "Dolphin" : "Demo";
  setTransportGlyph(elements.runButton, info.running ? GLYPH.pause : GLYPH.play,
                    info.running ? "Pause" : "Run",
                    info.running ? "Pause emulation" : "Resume emulation");
  elements.statusPill.classList.toggle("paused", !info.running);
  audio.update(info.buttonMask, info.running);
  syncMuteGlyph();
}

function updateDebugMetrics(info) {
  elements.frameCounter.textContent = String(info.frame);
  elements.fpsCounter.textContent = String(info.fps);
  if (elements.visualFpsCounter) {
    elements.visualFpsCounter.textContent =
      info.visualChangeFps == null ? "n/a" : String(info.visualChangeFps);
  }
  if (elements.gameSpeedCounter) {
    elements.gameSpeedCounter.textContent = `${Math.max(0, Number(info.gameSpeed) || 0)}%`;
  }
  elements.uiFpsCounter.textContent = String(info.uiFps ?? info.fps);
  if (elements.coreFpsCounter) {
    elements.coreFpsCounter.textContent = String(info.coreFps ?? info.fps);
  }
  if (elements.presentationGapCounter) {
    const p95Gap = Number(info.presentationP95IntervalMs) || 0;
    const maxGap = Number(info.presentationMaxIntervalMs) || 0;
    const longFrames = Number(info.presentationLongFrameCount) || 0;
    const formattedP95 = p95Gap.toFixed(p95Gap >= 10 ? 0 : 1);
    const formattedMax = maxGap.toFixed(maxGap >= 10 ? 0 : 1);
    elements.presentationGapCounter.textContent = `${formattedP95} p95 / ${formattedMax} max / ${longFrames}`;
  }
  if (elements.presentationLagCounter) {
    const frameLag = Math.max(0, Number(info.presentationFrameLag) || 0);
    const queueAge = Math.max(0, Number(info.presentationQueueAgeMs) || 0);
    elements.presentationLagCounter.textContent =
      `${frameLag.toFixed(0)}f / ${queueAge.toFixed(queueAge >= 10 ? 0 : 1)} ms`;
  }
  if (elements.audioStatus) {
    elements.audioStatus.textContent = audio.stats || audio.label();
  }
  elements.coreTicks.textContent = formatLargeInteger(info.coreTicks || 0);
  elements.ppcPc.textContent = formatHex(info.ppcPc || 0) || "-";
  elements.cpuCoreName.textContent = info.cpuCoreName || "-";
  elements.ppcWasmJit.textContent = `${formatLargeInteger(info.ppcWasmBlockRunCount || 0)} / ${formatLargeInteger(info.ppcWasmBlockCompileCount || 0)}`;
  elements.ppcWasmHelperStats.textContent = info.ppcWasmHelperStats || "-";
  if (elements.frameProfileStats) {
    elements.frameProfileStats.textContent = info.frameProfileStats || "-";
  }
}

function setStatus(message, tone = "") {
  elements.statusPill.textContent = message;
  elements.statusPill.classList.toggle("error", tone === "error");
}

function setMode(message) {
  elements.coreLabel.textContent = message;
  elements.adapterStatus.textContent = message.includes("Dolphin") ? "Detected" : "Fallback";
}

function wireTransport() {
  elements.runButton.addEventListener("click", () => {
    if (lastFrameInfo?.running) {
      host.pause();
      setStatus("Paused");
      host.publishFrame();
    } else {
      setStatus("Running");
      host.start();
    }
  });

  elements.resetButton.addEventListener("click", () => {
    host.reset();
    setStatus("Reset");
  });

  elements.saveButton.addEventListener("click", () => host.saveState());
  elements.loadButton.addEventListener("click", () => {
    host.loadState();
    syncGameInfo(host.game);
  });

  // Working save-state path (the slot Save/Load above are stubbed in
  // the discio core): DL State captures a version-matched .sav via
  // SaveStateFile and downloads it; UL State loads a .sav via
  // LoadStateFile. Both go through the real State::SaveToFileSync /
  // State::LoadAs path that §24 made functional.
  elements.dlStateButton.addEventListener("click", async () => {
    const btn = elements.dlStateButton;
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Saving…";
    setStatus("Capturing save state… (a few seconds)");
    try {
      const r = await window.__downloadSaveState("battle-state.sav");
      setStatus(
        r && r.saved
          ? `Save state downloaded (${r.size} B) — battle-state.sav`
          : `Save state failed: ${r?.error || "unknown"}`,
        r && r.saved ? undefined : "error");
    } catch (e) {
      setStatus(`Save state failed: ${e?.message || e}`, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });

  elements.ulStateInput.addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;
    setStatus(`Loading save state ${file.name}…`);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const a = host.adapter;
      if (!a || typeof a.loadStateFile !== "function") {
        setStatus("Upload state: adapter has no loadStateFile", "error");
        return;
      }
      const r = await a.loadStateFile(bytes);
      setStatus(
        r && r.loaded
          ? `Save state loaded (${r.afterState || "running"})`
          : `Save state load failed (rc=${r?.rc ?? "?"}${
              r?.error ? " " + r.error : ""})`,
        r && r.loaded ? undefined : "error");
    } catch (e) {
      setStatus(`Upload state failed: ${e?.message || e}`, "error");
    }
  });

  elements.muteButton.addEventListener("click", async () => {
    const muted = !audio.muted;
    syncMuteGlyph(muted);          // the key answers at once; the transport catches up below
    host.setAudioMuted(muted);
    await audio.setMuted(muted);
    syncMuteGlyph();
  });

  elements.fullscreenButton.addEventListener("click", async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await elements.dropZone.requestFullscreen();
    }
  });
}

function wireSettings() {
  populateSettingsForm(currentSettings);
  updateSettingsSummary();

  elements.settingsForm.addEventListener("change", () => {
    currentSettings = collectSettingsForm();
    updateSettingsSummary();
  });

  elements.settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const nextHref = buildSettingsHref(window.location.href, collectSettingsForm());
    window.location.assign(nextHref);
  });

  elements.settingsPresetButton.addEventListener("click", () => {
    window.location.assign(buildPlayablePresetHref(window.location.href));
  });
}

function wireDiagnostics() {
  const debugOpen = localStorage.getItem(DEBUG_PREF_KEY) === "1";
  const osdVisible = localStorage.getItem(OSD_PREF_KEY) !== "0";

  setDebugOpen(debugOpen);
  setOverlayVisible(osdVisible);

  elements.debugToggle.addEventListener("click", () => {
    setDebugOpen(elements.debugPanel.hidden);
  });

  elements.overlayToggle.addEventListener("click", () => {
    setOverlayVisible(elements.screenHud.hidden);
  });
}

function populateSettingsForm(settings) {
  elements.settingCore.value = settings.core;
  elements.settingVideo.value = settings.video;
  elements.settingResolution.value = settings.present;
  elements.settingSpeed.value = settings.speed;
  elements.settingCpu.value = settings.cpu;
  elements.settingPresenter.value = settings.presenter;
  elements.settingPacing.value = settings.pacing;
  elements.settingOglProxy.value = settings.oglproxy;
  elements.settingQueue.value = settings.queue;
  elements.settingFastSw.value = settings.fastsw;
  elements.settingSwThreads.value = settings.swthreads;
  elements.settingJitTier.value = settings.jittier;
  elements.settingWasmJit.checked = settings.wasmjit === "1";
  elements.settingForceJit.checked = settings.forcejit === "1";
  elements.settingMetrics.checked = settings.metrics === "1";
}

function collectSettingsForm() {
  return {
    core: elements.settingCore.value,
    video: elements.settingVideo.value,
    present: elements.settingResolution.value,
    speed: elements.settingSpeed.value,
    cpu: elements.settingCpu.value,
    presenter: elements.settingPresenter.value,
    pacing: elements.settingPacing.value,
    oglproxy: elements.settingOglProxy.value,
    queue: elements.settingQueue.value,
    fastsw: elements.settingFastSw.value,
    swthreads: elements.settingSwThreads.value,
    wasmjit: elements.settingWasmJit.checked ? "1" : "0",
    jittier: elements.settingJitTier.value,
    forcejit: elements.settingForceJit.checked ? "1" : "0",
    metrics: elements.settingMetrics.checked ? "1" : "0"
  };
}

function updateSettingsSummary() {
  elements.settingsSummary.textContent = describeSettings(currentSettings);
}

function setDebugOpen(open) {
  elements.debugPanel.hidden = !open;
  elements.debugToggle.setAttribute("aria-expanded", String(open));
  elements.debugToggle.classList.toggle("active", open);
  elements.debugToggle.textContent = open ? "DBG on" : "DBG";
  localStorage.setItem(DEBUG_PREF_KEY, open ? "1" : "0");
  if (open && lastFrameInfo) {
    updateDebugMetrics(lastFrameInfo);
  }
  setAutoScreenshotEnabled(open);
}

// Auto-screenshot: when DBG is on, snapshot the visible canvas every 3s and
// download as a PNG. State is attached to globalThis directly without a
// const/let intermediate so the function works regardless of where
// setDebugOpen is called from during module init (lexical declarations
// hit TDZ if accessed before their source line during the same module
// evaluation pass).
function setAutoScreenshotEnabled(enabled) {
  const state = (globalThis.__autoScreenshotState ??= { timer: null, count: 0 });
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  if (!enabled) return;
  state.count = 0;
  state.timer = setInterval(captureCanvasSnapshot, 3000);
}

function captureCanvasSnapshot() {
  try {
    const canvas = document.querySelector("#screen");
    if (!canvas) return;
    // Render the visible canvas into an offscreen 2D canvas first so we can
    // turn the result into a PNG even if the original is a transferred
    // OffscreenCanvas placeholder (which has no .toDataURL of its own).
    const cw = canvas.clientWidth || canvas.width || 320;
    const ch = canvas.clientHeight || canvas.height || 240;
    const snap = document.createElement("canvas");
    snap.width = cw;
    snap.height = ch;
    const ctx = snap.getContext("2d", { alpha: false });
    if (!ctx) return;
    ctx.drawImage(canvas, 0, 0, cw, ch);
    const dataUrl = snap.toDataURL("image/png");
    const state = (globalThis.__autoScreenshotState ??= { timer: null, count: 0 });
    state.count += 1;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `wasm-dolphin-${ts}-shot${String(state.count).padStart(3, "0")}.png`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (err) {
    console.warn("[auto-screenshot] failed:", err);
  }
}

function setOverlayVisible(visible) {
  elements.screenHud.hidden = !visible;
  elements.overlayToggle.setAttribute("aria-pressed", String(visible));
  elements.overlayToggle.classList.toggle("active", visible);
  elements.overlayToggle.textContent = visible ? "FPS on" : "FPS";
  localStorage.setItem(OSD_PREF_KEY, visible ? "1" : "0");
}


// Transport buttons are icons, so state changes swap the glyph and the
// accessible name. Writing textContent would delete the icon markup and leave
// a bare word inside a 44px key. Code points are numeric to keep this ASCII.
const GLYPH = {
  pause: String.fromCodePoint(0x23F8),
  play: String.fromCodePoint(0x25B6),
  muted: String.fromCodePoint(0x1F507),
  sound: String.fromCodePoint(0x1F50A)
};

function setTransportGlyph(button, glyph, label, tip) {
  if (!button) return;
  const span = button.querySelector(".glyph");
  if (span) span.textContent = glyph;
  else button.textContent = glyph;
  button.setAttribute("aria-label", label);
  if (tip) button.setAttribute("data-tip", tip);
}

// The mute key shows the state of the sound, and names the action a press takes.
// (It used to pick the icon by searching the audio label for "unmute", a word that
// label never contains — so it showed the muted icon whatever was playing.)
function syncMuteGlyph(muted = audio.muted) {
  const off = !audio.available;
  setTransportGlyph(elements.muteButton,
                    muted || off ? GLYPH.muted : GLYPH.sound,
                    off ? "Audio off" : muted ? "Unmute" : "Mute",
                    off ? "Audio is off" : muted ? "Unmute audio" : "Mute audio");
}

// Hide the entire side panel, not just the settings block. The game identity
// it used to carry now lives on the LCD strip in the bezel, so nothing is lost
// when it is hidden and the screen gets the width back.
//
// localStorage can throw (private windows, blocked site data) and must never
// stop the page loading, hence the guards at both ends.
function wirePanelToggle() {
  const toggle = elements.panelToggle;
  const panel = elements.controlPanel;
  if (!toggle || !panel) return;
  const apply = (open) => {
    panel.hidden = !open;
    document.body.classList.toggle("panel-hidden", !open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Hide side panel" : "Show side panel");
    toggle.classList.toggle("active", open);
  };
  let open = true;
  try { open = localStorage.getItem("wasmDolphinPanelOpen") !== "0"; } catch {}
  apply(open);
  toggle.addEventListener("click", () => {
    open = !open;
    apply(open);
    try { localStorage.setItem("wasmDolphinPanelOpen", open ? "1" : "0"); } catch {}
  });
}

// The dial is a range input under a drawn face: real keyboard and screen-reader
// behaviour for free, with the knob rotation driven off its value.
function wireVolumeDial() {
  const dial = elements.volumeDial;
  if (!dial) return;
  const face = dial.parentElement?.querySelector(".dial-face");
  const apply = () => {
    const pct = Number(dial.value) / 100;
    // -135deg (silent) to +135deg (full), the usual travel for a physical pot.
    if (face) face.style.setProperty("--angle", `${-135 + pct * 270}deg`);
    dial.parentElement?.setAttribute("data-tip", `Volume ${dial.value}%`);
  };
  dial.addEventListener("input", () => {
    audio.setVolume(Number(dial.value) / 100);
    apply();
    syncMuteGlyph();
  });
  apply();
}

// Mirror the game identity onto the bezel LCD.
function updateLcd(title, meta) {
  if (elements.lcdTitle) elements.lcdTitle.textContent = (title || "NO DISC").toUpperCase();
  if (elements.lcdMeta) elements.lcdMeta.textContent = (meta || "").toUpperCase();
}

// Screen aspect. The ratio is published as two CSS custom properties rather
// than a single "4 / 3" string so the fullscreen rule can do arithmetic with
// it -- fitting the picture to the real display instead of assuming 16:9.
function wireAspectSelect() {
  const select = elements.aspectSelect;
  if (!select) return;
  const apply = (value) => {
    const [w, h] = String(value).split(":");
    const root = document.documentElement;
    root.style.setProperty("--aspect-w", String(Number(w) || 4));
    root.style.setProperty("--aspect-h", String(Number(h) || 3));
  };
  let saved = null;
  try { saved = localStorage.getItem("wasmDolphinAspect"); } catch {}
  if (saved && [...select.options].some((o) => o.value === saved)) select.value = saved;
  apply(select.value);
  select.addEventListener("change", () => {
    apply(select.value);
    try { localStorage.setItem("wasmDolphinAspect", select.value); } catch {}
  });
}


// The CRT fits itself with a CSS min() against the available height, but that
// needs to know how much vertical space the non-picture chrome takes -- the
// page header, the LCD strip, the footer and the paddings. That was a magic
// 210px, which overflowed by a few pixels in short windows because the real
// value changes with the layout. Measure it instead and publish it as
// --crt-chrome; the CSS keeps doing the fitting.
function wireScreenFit() {
  const set = elements.dropZone;
  const viewport = document.querySelector(".screen-viewport");
  if (!set || !viewport) return;

  let lastChrome = -1;
  const measure = () => {
    if (document.fullscreenElement) return;  // fullscreen has its own rule
    const setBox = set.getBoundingClientRect();
    const vpBox = viewport.getBoundingClientRect();
    // Everything above the console, plus the console's own non-picture parts,
    // plus the gap left below it.
    const above = setBox.top + window.scrollY;
    const withinSet = setBox.height - vpBox.height;
    const chrome = Math.max(0, Math.round(above + withinSet + 24));
    // Writing this property resizes the console, which retriggers the
    // ResizeObserver. Only write on a real change, or the two feed each other
    // forever.
    if (Math.abs(chrome - lastChrome) <= 1) return;
    lastChrome = chrome;
    document.documentElement.style.setProperty("--crt-chrome", `${chrome}px`);
  };

  measure();
  window.addEventListener("resize", measure, { passive: true });
  document.addEventListener("fullscreenchange", measure);
  // The panel toggle and aspect changes both reflow the console.
  if (window.ResizeObserver) new ResizeObserver(measure).observe(set);
}

function wireFileMounting() {
  elements.romInput.addEventListener("change", async (event) => {
    const [file] = event.target.files;
    if (file) {
      await mountFile(file);
    }
  });

  for (const eventName of ["dragenter", "dragover"]) {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.add("dragging");
      elements.dropBadge.textContent = "Release";
    });
  }

  for (const eventName of ["dragleave", "drop"]) {
    elements.dropZone.addEventListener(eventName, () => {
      elements.dropZone.classList.remove("dragging");
      elements.dropBadge.textContent = "Drop disc";
    });
  }

  elements.dropZone.addEventListener("drop", async (event) => {
    event.preventDefault();
    const [file] = event.dataTransfer.files;
    if (file) {
      await mountFile(file);
    }
  });
}

function updateScreenHud(info) {
  elements.hudFps.textContent = formatMetricNumber(info.presentationFps ?? info.fps);
  elements.hudVisualFps.textContent =
    info.visualChangeFps == null ? "n/a" : formatMetricNumber(info.visualChangeFps);
  elements.hudSpeed.textContent = `${Math.max(0, Number(info.gameSpeed) || 0)}%`;
  elements.hudLatency.textContent = formatPresentationLag(info);
  elements.hudJit.textContent = parseJitState(info);
  elements.hudResolution.textContent = parsePresentationResolution(info);

  // Diagnostic fields parsed out of the worker's helper-stats string.
  const helper = String(info.ppcWasmHelperStats || "");
  elements.hudCoreFps.textContent = `${Math.max(0, Number(info.coreFps) || 0)}`;
  elements.hudFrame.textContent = `${info.frame ?? 0}`;

  const oglSwap = /\bogl_swap:(\d+)/.exec(helper)?.[1] ?? "0";
  elements.hudGlSwap.textContent = oglSwap;

  const present = /present\s+(\w+)\s+signal:(\w+)\s+mode:(\w+)/.exec(helper);
  if (present) {
    elements.hudMode.textContent = `${present[1]}/${present[3]}`;
  } else {
    elements.hudMode.textContent = "-";
  }

  const wd = /\bwd:(\d+)\/(\d+)/.exec(helper);
  elements.hudWatchdog.textContent = wd ? `${wd[1]}/${wd[2]}` : "0/0";

  const p95 = Number(info.presentationP95IntervalMs) || 0;
  const maxGap = Number(info.presentationMaxIntervalMs) || 0;
  elements.hudGap.textContent = `${Math.round(p95)}/${Math.round(maxGap)}`;

  const glerr = Number(info.oglGlError) || 0;
  elements.hudGlError.textContent = `0x${glerr.toString(16)}`;

  // §28v: richer diagnostic badges parsed from the worker helper
  // string so screenshots carry render/JIT health at a glance.
  const prim = /\bprim:(\d+)/.exec(helper)?.[1] ?? "0";
  const draw = /\bdraw:(\d+)/.exec(helper)?.[1] ?? "0";
  elements.hudDraw.textContent = `${prim}/${draw}`;

  const nz = /\bnz:(\d+)/.exec(helper)?.[1];
  elements.hudNz.textContent = nz == null ? "n/a" : nz;

  const under = /\bunderrun:(\d+)/.exec(helper)?.[1] ?? "0";
  const drop = /\bdrop:(\d+)/.exec(helper)?.[1] ?? "0";
  elements.hudUnderDrop.textContent = `${under}/${drop}`;

  const q = /\bqueue:(\d+)\/(\d+)/.exec(helper);
  const sig = /\bsignal:(\w+)/.exec(helper)?.[1] ?? "?";
  elements.hudQueue.textContent = q ? `${q[1]}/${q[2]}:${sig}` : `-:${sig}`;

  const jitc = /\bjitc:(\d+)\/(\d+)/.exec(helper);
  elements.hudJitCache.textContent = jitc ? `${jitc[1]}/${jitc[2]}` : "0/0";

  // §28cn per-slice CPU pthread profiler: avg/max/runOnlyMax wall time per
  // CoreTiming slice. max > 16000us = blew one 60Hz frame; runOnlyMax
  // separated from max so we can see whether the spike was compile-burst
  // or pure-emulation cost.
  const runloop = /\brunloop:(\d+)slices\/avg(\d+)us\/max(\d+)us\/runOnlyMax(\d+)us/.exec(helper);
  if (elements.hudRunloop) {
    elements.hudRunloop.textContent = runloop
      ? `${runloop[2]}/${runloop[3]}/${runloop[4]}`
      : "-/-/-";
  }

  const wgx = /\bwgx:d(\d+)\/mp(\d+)\/mb(\d+)\/sk(\d+)/.exec(helper);
  elements.hudWgx.textContent = wgx
    ? `d${wgx[1]} mp${wgx[2]} mb${wgx[3]} sk${wgx[4]}`
    : "-";

  if (elements.statusPill && elements.hudStatus) {
    const txt = elements.statusPill.textContent || "";
    elements.hudStatus.textContent = txt.length > 80 ? txt.slice(0, 77) + "..." : txt;
  }
}


// Apply the per-game profile before the core loads.
//
// The id is read straight from the disc file rather than from the mounted core,
// because by the time the core can report it the backend is already fixed --
// changing it then would mean a restart, and the file selection is gone.
//
// A profile carries up to three things (src/game-profiles.js): the renderer
// choice, upstream's GameSettings lines for the title, and the renderer feature
// bits the title needs. The "Auto per-game" switch governs all of them. An
// explicit ?video= flag overrides only the renderer choice: a measured default
// is a good guess, not a reason to override someone who has already decided,
// but the settings and features describe what the title needs on whichever
// path runs, so they still apply.
async function applyGameProfile(file) {
  if (!elements.autoProfile?.checked) {
    host.applyGameProfile(null);
    return;
  }
  let gameId = null;
  try {
    gameId = await readGameId(file);
  } catch {
    host.applyGameProfile(null);
    return;  // unreadable header is not a reason to fail the mount
  }
  const profile = lookupGameProfile(gameId);
  host.applyGameProfile(gameProfilePayload(gameId, profile));
  if (!profile) return;
  const notes = [];
  const rendererPinned = new URLSearchParams(window.location.search).has("video");
  if (!rendererPinned) {
    const backend = profile.renderer === "hardware" ? "WebGPU-Real" : "Software Renderer";
    if (host.applyVideoBackend(backend)) notes.push(`${profile.renderer} renderer`);
  }
  if (profile.ini) notes.push(`upstream ${profile.upstream ?? "game settings"}`);
  const features = Object.entries(profile.features ?? {})
    .filter(([, on]) => on)
    .map(([name]) => name);
  if (features.length) notes.push(`features: ${features.join(" ")}`);
  if (notes.length) setStatus(`${gameId}: ${notes.join("; ")} (${profile.why})`);
}

async function mountFile(file, { profileApplied = false } = {}) {
  try {
    if (!profileApplied) await applyGameProfile(file);
    const game = await host.mountFile(file);
    // Auto-unmute on disc boot. AudioController defaults to muted because
    // the AudioContext can only be created after a user gesture; the disc
    // mount click is the user gesture, so unmute here so audio actually
    // plays. Users can still mute via the button.
    if (audio.muted) {
      await audio.setMuted(false);
      syncMuteGlyph();
    }
    host.setAudioMuted(audio.muted);
    syncGameInfo(game);
    host.start();
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function syncGameInfo(game) {
  elements.gameTitle.textContent = game.name;
  elements.gameSize.textContent = game.size ? formatBytes(game.size) : "No file";
  const coreDetail = [game.gameId, game.platform, game.region].filter(Boolean).join(" / ");
  // Feed the bezel LCD the same identity, so hiding the side panel loses
  // nothing. Size sits next to the id/platform/region the panel showed.
  updateLcd(game.name, [coreDetail, game.size ? formatBytes(game.size) : ""]
    .filter(Boolean).join("  ·  "));
  elements.mountNote.textContent =
    host.mode === "dolphin"
      ? `${game.core || "Dolphin core"} active${coreDetail ? `: ${coreDetail}` : ""}`
      : "Demo WASM core active";
  syncBootInfo(game);
}

function syncBootInfo(game) {
  const mounted = host.mode === "dolphin" && game?.gameId;
  elements.bootStatus.textContent = mounted ? `${game.rootEntryCount ?? 0} root` : "No disc";
  elements.bootApploader.textContent = mounted
    ? [formatBytesMaybe(game.apploaderSize), game.apploaderDate].filter(Boolean).join(" / ")
    : "-";
  elements.bootDol.textContent = mounted ? formatOffsetSize(game.bootDolOffset, game.bootDolSize) : "-";
  elements.bootFst.textContent = mounted ? formatOffsetSize(game.fstOffset, game.fstSize) : "-";
  elements.bootImage.textContent = mounted ? formatImageSizes(game.rawSize, game.dataSize) : "-";
  elements.bootEntry.textContent = mounted ? formatHex(game.bootProbe?.dol?.entryPoint) || "-" : "-";
  elements.bootBlocker.textContent = mounted
    ? [game.bootProbe?.blocker, game.coreStatus].filter(Boolean).join(" / ") || "Boot probe unavailable"
    : "No boot attempt";
  renderRootEntries(mounted ? game.rootEntries ?? [] : []);
}

function renderRootEntries(entries) {
  elements.rootEntryList.replaceChildren();

  if (entries.length === 0) {
    const empty = document.createElement("span");
    empty.className = "root-entry-empty";
    empty.textContent = "No root entries";
    elements.rootEntryList.append(empty);
    return;
  }

  for (const entry of entries.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "root-entry";

    const name = document.createElement("span");
    name.textContent = entry.path || entry.name || "/";

    const size = document.createElement("strong");
    size.textContent = entry.directory ? "dir" : formatBytesMaybe(entry.size);

    row.append(name, size);
    elements.rootEntryList.append(row);
  }
}

function wireKeyboard() {
  document.addEventListener("keydown", (event) => {
    if (event.repeat) {
      return;
    }

    const wiimoteKey = resolveWiimoteKey(event.code);
    if (wiimoteKey && !isTypingTarget(event.target)) {
      wiimoteKeys.add(wiimoteKey);
      syncWiimote();
    }

    const button = resolveKeyboardButton(event.code);
    if (!button) {
      if (wiimoteKey) event.preventDefault();
      return;
    }

    event.preventDefault();
    const nextKeyboard = updatePressedSet(keyboardPressed, button, true);
    keyboardPressed.clear();
    for (const pressed of nextKeyboard) keyboardPressed.add(pressed);
    syncInput("Keyboard");
  });

  document.addEventListener("keyup", (event) => {
    const wiimoteKey = resolveWiimoteKey(event.code);
    if (wiimoteKey && wiimoteKeys.delete(wiimoteKey)) {
      syncWiimote();
    }

    const button = resolveKeyboardButton(event.code);
    if (!button) {
      if (wiimoteKey) event.preventDefault();
      return;
    }

    event.preventDefault();
    keyboardPressed.delete(button);
    syncInput("Keyboard");
  });
}

function isTypingTarget(target) {
  const tag = target?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || Boolean(target?.isContentEditable);
}

// The pointer over the game is Wii Remote 1's IR cursor; its buttons are A and B (and a
// middle click shakes). Off the game the cursor is hidden, as a real remote pointed away
// from the sensor bar. The context menu stays off the game so right click can be B.
function wireWiimotePointer() {
  const screen = elements.screen;
  if (!screen) return;
  const updateCursor = (event) => {
    wiimoteCursor = cursorFromPointer(screen.getBoundingClientRect(), event.clientX, event.clientY);
    syncWiimote();
  };
  screen.addEventListener("pointermove", updateCursor);
  screen.addEventListener("pointerenter", updateCursor);
  screen.addEventListener("pointerleave", () => {
    wiimoteCursor = null;
    syncWiimote();
  });
  screen.addEventListener("pointerdown", (event) => {
    const name = DEFAULT_WIIMOTE_MOUSE_BINDINGS[event.button];
    if (!name) return;
    event.preventDefault();
    wiimoteMouseButtons.add(name);
    updateCursor(event);
  });
  const release = (event) => {
    const name = DEFAULT_WIIMOTE_MOUSE_BINDINGS[event.button];
    if (name && wiimoteMouseButtons.delete(name)) syncWiimote();
  };
  // Released anywhere: a drag that ends off the game must still let go of the button.
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
  window.addEventListener("blur", () => {
    if (wiimoteMouseButtons.size === 0 && wiimoteKeys.size === 0) return;
    wiimoteMouseButtons.clear();
    wiimoteKeys.clear();
    syncWiimote();
  });
  screen.addEventListener("contextmenu", (event) => event.preventDefault());
}

function syncWiimote() {
  host.setWiimoteState(wiimoteStateFromInputs({
    keys: wiimoteKeys,
    mouseButtons: wiimoteMouseButtons,
    cursor: wiimoteCursor,
    gamepad: wiimoteGamepad
  }));
}

function wireTouchControls() {
  const touchButtons = document.querySelectorAll("[data-touch-button]");
  for (const button of touchButtons) {
    const control = button.dataset.touchButton;
    const press = (event) => {
      event.preventDefault();
      touchPressed = updatePressedSet(touchPressed, control, true);
      syncInput("Touch");
    };
    const release = (event) => {
      event.preventDefault();
      touchPressed = updatePressedSet(touchPressed, control, false);
      syncInput("Touch");
    };

    button.addEventListener("pointerdown", press);
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("pointerleave", release);
  }
}

function wireGamepadPolling() {
  // §28cj diagnostic + escape-hatch modes. URL params:
  //   ?nogamepad=1     — skip gamepad polling entirely; keyboard-only play
  //   ?gamepaddebug=1  — per-frame console dump + sticky on-page HUD of
  //                      every navigator.getGamepads() entry (id, mapping,
  //                      axes, pressed buttons). Use to attribute phantom
  //                      inputs when split-deadzone tuning isn't enough.
  const params = new URLSearchParams(window.location.search);
  if (params.get("nogamepad") === "1") {
    console.log("[gamepad] disabled via ?nogamepad=1 — keyboard/touch only this session");
    return;
  }
  const debugGamepad = params.get("gamepaddebug") === "1";
  const legacyGamepadPoll = params.get("legacygamepadpoll") === "1";
  let _gpLastLog = 0;
  let _gpHud = null;
  if (debugGamepad) {
    _gpHud = document.createElement("pre");
    _gpHud.id = "gamepad-debug-hud";
    Object.assign(_gpHud.style, {
      position: "fixed",
      top: "8px",
      right: "8px",
      maxWidth: "560px",
      maxHeight: "60vh",
      overflow: "auto",
      padding: "8px 10px",
      background: "rgba(0,0,0,0.85)",
      color: "#0f0",
      font: "11px/1.3 ui-monospace,Menlo,Consolas,monospace",
      zIndex: 99999,
      pointerEvents: "none",
      whiteSpace: "pre",
      border: "1px solid #0f0",
      borderRadius: "4px"
    });
    _gpHud.textContent = "[gamepad-debug] waiting for first poll…";
    document.body.appendChild(_gpHud);
  }

  // Poll on a 2ms interval rather than rAF. The Gamepad API has no event
  // model so we must poll, but rAF caps the cadence at the display refresh
  // rate (~16.7ms), which adds a worst-case full-frame of latency to every
  // gamepad input. setInterval at 2ms cuts that floor to ~2ms.
  const poll = () => {
    const pads = navigator.getGamepads?.() ?? [];
    // §28ck device selection. `pads.find(Boolean)` (the old code) picked
    // index [0] regardless of whether it was a real controller or a
    // phantom HID device with empty mapping and axes stuck at extremes
    // (e.g. Xbox accessory at Product 0x03c3 with all axes pinned to -1).
    // Prefer pads with W3C `mapping === "standard"` — those are real
    // controllers whose button/axis indexes match our STANDARD_GAMEPAD_*
    // assumptions. Fall back to first non-null only if no standard pad
    // is present. Among multiple standard pads, the one with the highest
    // button count usually wins (Xbox Wireless = 17, generic = fewer).
    const firstPad = selectPreferredGamepad(pads);

    if (debugGamepad) {
      const now = performance.now();
      if (now - _gpLastLog > 250) {
        _gpLastLog = now;
        const lines = [`[gamepad-debug] pads.length=${pads.length} t=${(now/1000).toFixed(1)}s`];
        let anyPad = false;
        for (let i = 0; i < pads.length; i++) {
          const p = pads[i];
          if (!p) { lines.push(`  [${i}] null`); continue; }
          anyPad = true;
          const axes = (p.axes || []).map((a, j) => `a${j}=${a.toFixed(3)}`).join(" ");
          const pressedBtns = [];
          for (let b = 0; b < (p.buttons || []).length; b++) {
            const btn = p.buttons[b];
            if (btn?.pressed || (btn?.value ?? 0) > 0.05) {
              pressedBtns.push(`b${b}=${(btn.value ?? (btn.pressed ? 1 : 0)).toFixed(2)}`);
            }
          }
          lines.push(`  [${i}] id="${p.id}"`);
          lines.push(`      mapping=${p.mapping || "?"} connected=${p.connected} buttons=${(p.buttons||[]).length} axes=${(p.axes||[]).length}`);
          lines.push(`      ${axes}`);
          lines.push(`      pressed:[${pressedBtns.join(" ") || "(none)"}]`);
        }
        if (!anyPad) lines.push("  (no gamepad detected yet — press a button on the controller to wake the API)");
        const text = lines.join("\n");
        if (_gpHud) _gpHud.textContent = text;
        // Also log once per second to console for copy-paste convenience.
        if (now - (_gpLastLog - 250) > 1000 || _gpLastLog < 1500) {
          // eslint-disable-next-line no-console
          console.log(text);
        }
      }
    }

    wiimoteGamepad = firstPad ? readWiimoteFromGamepad(firstPad) : null;
    syncWiimote();

    const nextGamepadInput = firstPad ? readGamepadInput(firstPad) : null;
    if (!legacyGamepadPoll && gamepadInputsEqual(lastGamepadInput, nextGamepadInput)) {
      return;
    }

    lastGamepadInput = nextGamepadInput;
    gamepadPressed = nextGamepadInput?.pressed ?? new Set();
    gamepadInputState = nextGamepadInput?.state ?? null;

    if (gamepadPressed.size > 0) {
      syncInput("Gamepad");
    } else {
      syncInput(elements.inputSource.textContent === "Gamepad" ? "Keyboard" : elements.inputSource.textContent);
    }
  };

  setInterval(poll, 2);
}

function syncInput(source) {
  combinedPressed = mergePressedSets(keyboardPressed, touchPressed, gamepadPressed);
  host.setInputState(inputStateFromPressed(combinedPressed, gamepadInputState));
  elements.inputSource.textContent = source;

  for (const chip of elements.controlGrid.children) {
    chip.classList.toggle("active", combinedPressed.has(chip.dataset.control));
  }
}

function renderControlGrid() {
  const fragment = document.createDocumentFragment();

  for (const label of CONTROL_LABELS) {
    const chip = document.createElement("span");
    chip.className = "control-chip";
    chip.dataset.control = label;
    chip.textContent = formatControlLabel(label);
    fragment.append(chip);
  }

  elements.controlGrid.append(fragment);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatBytesMaybe(bytes) {
  return Number.isFinite(bytes) && bytes >= 0 ? formatBytes(bytes) : "";
}

function formatHex(value) {
  return Number.isFinite(value) && value >= 0 ? `0x${Math.trunc(value).toString(16).toUpperCase()}` : "";
}

function formatLargeInteger(value) {
  return Number.isFinite(value) ? Math.trunc(value).toLocaleString("en-US") : "0";
}

function formatMetricNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "0";
  }

  return numeric >= 10 ? String(Math.round(numeric)) : numeric.toFixed(1);
}

function formatPresentationLag(info) {
  const frameLag = Math.max(0, Number(info.presentationFrameLag) || 0);
  return `${frameLag.toFixed(0)}f`;
}

function parseJitState(info) {
  const helperStats = info.ppcWasmHelperStats || "";
  const match = /(?:^|\s)jit:([a-z0-9_-]+)/i.exec(helperStats);
  if (match) {
    return match[1] === "on" ? "JIT on" : `JIT ${match[1]}`;
  }

  if ((info.ppcWasmBlockCompileCount || 0) > 0 || (info.ppcWasmBlockRunCount || 0) > 0) {
    return "JIT active";
  }

  return currentSettings.wasmjit === "1" ? "JIT armed" : "JIT off";
}

function parsePresentationResolution(info) {
  const helperStats = info.ppcWasmHelperStats || "";
  const match = /present:(\d+x\d+)/i.exec(helperStats);
  if (match) {
    return match[1];
  }

  return `${elements.screen.width}x${elements.screen.height}`;
}

function formatOffsetSize(offset, size) {
  const parts = [formatHex(offset), formatBytesMaybe(size)].filter(Boolean);
  return parts.length > 0 ? parts.join(" / ") : "-";
}

function formatImageSizes(rawSize, dataSize) {
  const raw = formatBytesMaybe(rawSize);
  const data = formatBytesMaybe(dataSize);
  return raw && data ? `${raw} / ${data}` : raw || data || "-";
}

// ?disc=<same-origin URL>: a disc on the server. The page's own way in is a dropped
// File; with ?disc= the image stays on the server and the worker reads it through
// src/remote-disc.js -- memory, then this device's copy (OPFS), then HTTP Range -- while
// a fetch worker pulls the whole image onto this device. The page needs only the size
// and validators (a HEAD) and the header for the game id. A click is still needed (the
// AudioContext wants a gesture), so the drop zone becomes a start button. Settings
// that reload the page keep the parameter; ?prefetch=0 and ?opfs=0 travel with the disc.
function wireRemoteDisc() {
  wireDiscLibrary();
  const param = new URLSearchParams(window.location.search).get("disc");
  if (!param) return;
  let url;
  try {
    url = new URL(param, window.location.href);
  } catch {
    setStatus("?disc= is not a URL", "error");
    return;
  }
  if (url.origin !== window.location.origin) {
    setStatus("?disc= must be on this site", "error");
    return;
  }
  const name = decodeURIComponent(url.pathname.split("/").pop() || "disc");
  const flags = readRemoteDiscFlags(window.location.search);
  elements.discCache.hidden = false;
  elements.dropBadge.textContent = `Loading ${name}…`;
  elements.gameTitle.textContent = name;
  try { elements.discDownloadFirst.checked = localStorage.getItem(DISC_DOWNLOAD_FIRST_KEY) === "1"; } catch {}
  elements.discDownloadFirst.disabled = !flags.opfs;
  elements.discDownloadFirst.addEventListener("change", () => {
    try { localStorage.setItem(DISC_DOWNLOAD_FIRST_KEY, elements.discDownloadFirst.checked ? "1" : "0"); } catch {}
  });
  elements.discRemoveButton.addEventListener("click", () => removeDiscFromDevice(remoteDiscState.key, name));
  if (flags.recordReads && elements.discReadsButton) {
    elements.discReadsButton.hidden = false;
    elements.discReadsButton.addEventListener("click", saveReadOrder);
  }
  window.__discReadOrder = currentReadOrder;
  window.addEventListener("pagehide", flushRemoteDisc);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flushRemoteDisc(); });

  fetch(url, { method: "HEAD", credentials: "same-origin", cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error(`the disc answered HTTP ${response.status}`);
      const size = Number(response.headers.get("Content-Length"));
      if (!size) throw new Error("the server gave no size for the disc");
      if (response.headers.get("Accept-Ranges") === "none") throw new Error("the server doesn't do Range requests");
      const disc = new RemoteDisc({
        url: url.href,
        name,
        size,
        etag: response.headers.get("ETag"),
        lastModified: response.headers.get("Last-Modified"),
        ...flags
      });
      remoteDiscState.disc = disc;
      remoteDiscState.key = discCacheKey(disc.url);
      elements.gameSize.textContent = formatBytes(size);
      elements.dropBadge.textContent = `Start ${name}`;
      elements.dropBadge.classList.add("start");
      const start = (event) => {
        event.preventDefault();
        elements.dropZone.removeEventListener("click", start);
        startRemoteDisc(disc);
      };
      elements.dropZone.addEventListener("click", start);
      setStatus(`${name} (${formatBytes(size)}) — click the screen to start`);
      renderDiscPanel(null);
    })
    .catch((error) => {
      elements.dropBadge.textContent = "Disc unavailable";
      setStatus(error.message, "error");
    });
}

async function startRemoteDisc(disc) {
  if (disc.opfs) askPersistOnce();
  elements.dropBadge.textContent = "Starting…";
  startDiscPolling();
  let profileApplied = false;
  if (disc.opfs && elements.discDownloadFirst.checked) {
    await applyGameProfile(disc);
    profileApplied = true;
    const prepared = await host.prepareRemoteDisc(disc).catch((error) => {
      setStatus(`The download could not start: ${error.message}`, "error");
      return null;
    });
    if (prepared?.disc) {
      showDiscStats(prepared.disc);
      if (prepared.disc.mode === "cached" && !prepared.disc.complete) await waitForFullDownload();
      else if (prepared.disc.mode !== "cached") setStatus(`Starting without the full download: ${prepared.disc.reason}`);
    }
    elements.dropBadge.textContent = "Starting…";
  }
  await mountFile(disc, { profileApplied });
  elements.dropBadge.textContent = "";
  elements.dropBadge.classList.remove("start");
}

// "Download fully before starting": the boot waits for the bitmap to be complete. The
// badge counts it up; a click starts the game at once (the download carries on).
function waitForFullDownload() {
  return new Promise((resolve) => {
    let timer = null;
    const finish = () => {
      clearInterval(timer);
      elements.dropZone.removeEventListener("click", skip);
      resolve();
    };
    const skip = (event) => {
      event.preventDefault();
      finish();
    };
    elements.dropZone.addEventListener("click", skip);
    timer = setInterval(async () => {
      const stats = await pollDiscStats();
      if (!stats) return;
      if (stats.mode !== "cached" || stats.complete) {
        finish();
        return;
      }
      const pct = stats.size ? Math.floor((stats.storedBytes / stats.size) * 100) : 0;
      elements.dropBadge.textContent = `Downloading ${pct}% · ${formatDiscRate(stats.rate)} — click to start now`;
    }, 500);
  });
}

function startDiscPolling() {
  if (remoteDiscState.poll) return;
  remoteDiscState.poll = setInterval(pollDiscStats, 1000);
}

async function pollDiscStats() {
  try {
    const response = await host.discRequest("discStats");
    if (!response?.disc) return null;
    showDiscStats(response.disc);
    return response.disc;
  } catch {
    return null;    // the worker is busy or gone
  }
}

function showDiscStats(stats) {
  remoteDiscState.stats = stats;
  window.__discStats = stats;
  renderDiscPanel(stats);
  const now = performance.now();
  if (stats.complete !== remoteDiscState.complete || now - remoteDiscState.libraryAt > 15000) {
    remoteDiscState.complete = stats.complete;
    remoteDiscState.libraryAt = now;
    refreshDiscLibrary();
  }
}

function formatDiscRate(bytesPerSecond) {
  return `${((Number(bytesPerSecond) || 0) / 1e6).toFixed(1)} MB/s`;
}

// "On this device: 1.2 GB of 1.4 GB · 11.8 MB/s" from the worker's numbers, or from the
// listing before the worker exists.
async function renderDiscPanel(stats) {
  const disc = remoteDiscState.disc;
  if (!disc) return;
  let line;
  if (stats) {
    if (stats.mode === "cached") {
      const moving = stats.sequential === "running" || stats.sequential === "parked";
      line = stats.complete
        ? `On this device: ${formatDiscBytes(stats.size)} (all of it)`
        : `On this device: ${formatDiscBytes(stats.storedBytes)} of ${formatDiscBytes(stats.size)}${moving ? ` · ${formatDiscRate(stats.rate)}` : ""}`;
    } else {
      line = `Streaming only: ${stats.reason || "no copy on this device"}`;
    }
    // "· waited 13× (2.9 s, last 0.21 s) · link 18 Mbit/s, 95 ms": the last wait and the
    // fetch worker's estimate of the link, once there is one (the rest is in __discStats).
    const lastWait = stats.waits && stats.demand ? `, last ${(stats.demand.lastWindowMs / 1000).toFixed(2)} s` : "";
    const link = stats.link?.mbit ? ` · link ${stats.link.mbit} Mbit/s, ${stats.link.rttMs} ms` : "";
    elements.discNetNote.textContent =
      `${formatDiscBytes(stats.bytes)} from the network · waited ${stats.waits}× (${(stats.waitMs / 1000).toFixed(1)} s${lastWait})${link}`;
    elements.discRemoveButton.disabled = stats.mode !== "cached";
  } else if (!disc.opfs) {
    line = "Streaming only: turned off (?opfs=0)";
  } else {
    const entry = await opfsRoot().then((root) => readCachedDiscEntry(root, disc)).catch(() => null);
    if (remoteDiscState.stats) return;     // the worker's numbers arrived meanwhile
    line = !entry
      ? "On this device: nothing yet"
      : !entry.matches
        ? "On this device: an older version (it will be replaced)"
        : entry.complete
          ? `On this device: ${formatDiscBytes(entry.size)} (all of it)`
          : `On this device: ${formatDiscBytes(entry.storedBytes)} of ${formatDiscBytes(entry.size)}`;
    elements.discRemoveButton.disabled = !entry;
  }
  elements.discCacheNote.textContent = line;
}

// Asked once, on the first Start with a copy on this device: without it the browser may
// evict a multi-gigabyte image under storage pressure (an evicted copy just starts over).
function askPersistOnce() {
  if (!navigator.storage?.persist) return;
  try {
    if (localStorage.getItem(DISC_PERSIST_ASKED_KEY)) return;
    localStorage.setItem(DISC_PERSIST_ASKED_KEY, "1");
  } catch {
    return;
  }
  navigator.storage.persisted()
    .then((already) => already || navigator.storage.persist())
    .then((granted) => console.log(`[disc] persistent storage ${granted ? "granted" : "not granted"}`))
    .catch(() => {});
}

function flushRemoteDisc() {
  try { host.discRequest("discFlush").catch(() => {}); } catch { /* no worker yet */ }
}

function wireDiscLibrary() {
  if (!navigator.storage?.getDirectory || !elements.discLibrary) return;
  elements.discLibrary.hidden = false;
  refreshDiscLibrary();
}

async function refreshDiscLibrary() {
  const root = await opfsRoot();
  if (!root || !elements.discLibraryList) return;
  let discs = [];
  try {
    discs = await listCachedDiscs(root);
  } catch (error) {
    console.warn("[disc] listing the discs on this device failed:", error);
  }
  const rows = [];
  let total = 0;
  for (const disc of discs) {
    const live = disc.key === remoteDiscState.key && remoteDiscState.stats?.mode === "cached" ? remoteDiscState.stats : null;
    const stored = live ? live.storedBytes : disc.storedBytes;
    const complete = live ? live.complete : disc.complete;
    total += stored ?? disc.size;
    const row = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = disc.name;
    if (disc.url) label.title = disc.url;
    const size = document.createElement("strong");
    size.textContent = stored == null || complete
      ? formatDiscBytes(disc.size)
      : `${formatDiscBytes(stored)} of ${formatDiscBytes(disc.size)}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => removeDiscFromDevice(disc.key, disc.name));
    row.append(label, size, remove);
    rows.push(row);
  }
  if (!rows.length) {
    const empty = document.createElement("li");
    empty.className = "muted compact";
    empty.textContent = "None yet. A disc opened with ?disc= is kept here.";
    rows.push(empty);
  }
  elements.discLibraryList.replaceChildren(...rows);
  elements.discLibraryTotal.textContent = discs.length ? `${discs.length} · ${formatDiscBytes(total)}` : "";
}

// ?recordreads=1: the order the core has read this disc's blocks in so far, as a
// <GAMEID>.reads.json -- block numbers and times, nothing of the game. Kept beside the disc
// file as <disc file>.reads.json, it puts those blocks first in the sequential stream of
// every later first launch (src/remote-disc.js). tools/probe.mjs in dolphin-browser saves
// one from a scripted session through window.__discReadOrder.
async function currentReadOrder() {
  const response = await host.discRequest("discReads").catch(() => null);
  const reads = response?.reads;
  if (!reads) return null;
  let game = null;
  try { game = remoteDiscState.disc ? await readGameId(remoteDiscState.disc) : null; } catch { /* no header: the file name will do */ }
  return { v: reads.v, game, name: reads.name, size: reads.size, block: reads.block, blocks: reads.blocks, seconds: reads.seconds };
}

async function saveReadOrder() {
  const order = await currentReadOrder();
  if (!order) {
    setStatus("No read order yet: the disc hasn't been read with ?recordreads=1", "error");
    return;
  }
  const url = URL.createObjectURL(new Blob([JSON.stringify(order)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${order.game || order.name}.reads.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  setStatus(`Read order saved: ${order.blocks.length} blocks — keep it beside the disc as ${order.name}.reads.json`);
}

// The running disc's copy is released by the worker first (it holds the files open);
// any other copy goes straight from here. Another tab holding it is the one refusal.
async function removeDiscFromDevice(key, name) {
  if (!key) return;
  try {
    if (key === remoteDiscState.key) {
      const response = await host.discRequest("discRemove");
      if (response?.disc) showDiscStats(response.disc);
    }
    await removeCachedDisc(await opfsRoot(), key);
    setStatus(`${name} removed from this device`);
  } catch (error) {
    setStatus(error?.name === "NoModificationAllowedError"
      ? `${name} is open in another tab; close it there first`
      : `Could not remove ${name}: ${error?.message || error}`, "error");
  }
  if (key === remoteDiscState.key && !remoteDiscState.stats) renderDiscPanel(null);
  refreshDiscLibrary();
}

async function runSmokeScenario() {
  const scenario = new URLSearchParams(window.location.search).get("smoke");
  if (scenario !== "melee") {
    return;
  }

  const header = new Uint8Array(0x3000);
  header.set(new TextEncoder().encode("GALE01"), 0);
  header.set([0xc2, 0x33, 0x9f, 0x3d], 0x1c);
  header.set(new TextEncoder().encode("Super Smash Bros. Melee"), 0x20);
  header.set([0x00, 0x00, 0x00, 0x01], 0x458);
  header.set(new TextEncoder().encode("2026/05/05"), 0x2440);
  writeU32BE(header, 0x420, 0x1000);
  writeU32BE(header, 0x424, 0x2800);
  writeU32BE(header, 0x428, 0x24);
  writeU32BE(header, 0x1000, 0x100);
  writeU32BE(header, 0x1048, 0x80003100);
  writeU32BE(header, 0x1090, 0x40);
  writeU32BE(header, 0x10d8, 0x80400000);
  writeU32BE(header, 0x10dc, 0x1000);
  writeU32BE(header, 0x10e0, 0x80003100);
  writeU32BE(header, 0x2454, 0x20);
  writeU32BE(header, 0x2458, 0x10);
  writeU32BE(header, 0x2800, 0x01000000);
  writeU32BE(header, 0x2804, 0);
  writeU32BE(header, 0x2808, 2);
  writeU32BE(header, 0x280c, 0);
  writeU32BE(header, 0x2810, 0x2900);
  writeU32BE(header, 0x2814, 4);
  header.set(new TextEncoder().encode("opening.bnr"), 0x2818);
  header.set(new TextEncoder().encode("BNR1"), 0x2900);

  const file = new File([header], "Super Smash Bros Melee.iso", {
    type: "application/octet-stream"
  });
  await mountFile(file);
  window.__wasmDolphinSmoke = {
    mode: host.mode,
    game: host.game
  };
}

function writeU32BE(bytes, offset, value) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}
