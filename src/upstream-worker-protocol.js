export const DEFAULT_UPSTREAM_CORE_URL = "./cores/dolphin/dolphin-core-upstream.js";
export const DEFAULT_UPSTREAM_CORE_SHA256 = "3b734762589306c6f74d3bfde1f9ad9b54d424a67e8123e8c5e04ed4c27d9f2c";
export const DISCIO_UPSTREAM_CORE_URL = "./cores/dolphin/dolphin-upstream.js";
export const WORKERFS_MOUNT_DIR = "/workerfs";
export const XFB_FAST_PATH_FLAGS = Object.freeze({
  rows: 1,
  decode: 2,
  both: 3
});
export const SOFTWARE_TEV_HOT_CASE_MODE = Object.freeze({
  execute: 1,
  shadow: 2
});

export const ONE_WAY_WORKER_REQUEST_TYPES = Object.freeze([
  "setAudioMuted",
  "setInputMask",
  "setInputState",
  "setWiimoteState"
]);

const ONE_WAY_WORKER_REQUEST_TYPE_SET = new Set(ONE_WAY_WORKER_REQUEST_TYPES);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function requestedLegacyOneWayAck(search = globalThis.location?.search ?? "") {
  return new URLSearchParams(search).get("legacyonewayack") === "1";
}

export function requestedXfbFastPaths(search = globalThis.location?.search ?? "") {
  const requested = (new URLSearchParams(search).get("xfbfast") || "").trim().toLowerCase();
  if (requested === "rows" || requested === "row" || requested === "reuse" || requested === "1") {
    return XFB_FAST_PATH_FLAGS.rows;
  }
  if (requested === "decode" || requested === "2") {
    return XFB_FAST_PATH_FLAGS.decode;
  }
  if (requested === "both" || requested === "all" || requested === "3") {
    return XFB_FAST_PATH_FLAGS.both;
  }
  return 0;
}

// ?swthreads= selects how many worker threads rasterize alongside the GPU thread on the
// software renderer. "auto" (the default) lets the worker size it from the machine's core
// count; "0" is the upstream single-threaded rasterizer; 1-8 is an explicit count.
export const SOFTWARE_RASTER_THREADS_MAX = 8;

export function requestedSoftwareRasterThreads(search = globalThis.location?.search ?? "") {
  const raw = (new URLSearchParams(search).get("swthreads") || "").trim().toLowerCase();
  if (raw === "" || raw === "auto") return "auto";
  if (raw === "off" || raw === "none") return 0;
  const count = Number.parseInt(raw, 10);
  if (!Number.isFinite(count)) return "auto";
  return Math.max(0, Math.min(SOFTWARE_RASTER_THREADS_MAX, count));
}

// Resolves the requested setting to a worker count for one boot. The CPU thread and the GPU
// thread each want a core of their own and the browser needs one, so the automatic choice
// leaves those alone: half the logical cores minus two, capped at four. Only the software
// renderer has a rasterizer to split.
export function resolveSoftwareRasterThreads(requested, { videoBackend = "Software Renderer",
  hardwareConcurrency = globalThis.navigator?.hardwareConcurrency } = {}) {
  if (videoBackend !== "Software Renderer") return 0;
  if (requested === "auto" || requested === undefined || requested === null) {
    const cores = Number(hardwareConcurrency) || 0;
    return Math.max(0, Math.min(4, Math.floor(cores / 2) - 2));
  }
  const count = Number(requested);
  if (!Number.isFinite(count)) return 0;
  return Math.max(0, Math.min(SOFTWARE_RASTER_THREADS_MAX, Math.trunc(count)));
}

export function requestedSoftwareTevHotCaseMode(search = globalThis.location?.search ?? "") {
  const params = new URLSearchParams(search);
  let mode = 0;
  if (params.get("swtevfast") === "1") mode |= SOFTWARE_TEV_HOT_CASE_MODE.execute;
  if (params.get("swtevshadow") === "1") mode |= SOFTWARE_TEV_HOT_CASE_MODE.shadow;
  return mode;
}

export function isOneWayWorkerRequestType(type) {
  return ONE_WAY_WORKER_REQUEST_TYPE_SET.has(type);
}

export function isStrictOneWayWorkerRequest(message) {
  return Boolean(
    message?.oneWay === true &&
    message?.id === undefined &&
    isOneWayWorkerRequestType(message?.type)
  );
}

export function planWorkerSuccessReply(
  message,
  result = {},
  { legacyOneWayAck = false } = {}
) {
  const { transfer = [], ...payload } = result ?? {};
  const reply = { id: message?.id, ok: true, ...payload };
  const oneWay = isStrictOneWayWorkerRequest(message);
  return {
    estimatedReplyJsonBytes: oneWay ? estimateWorkerMessageJsonBytes(reply) : 0,
    oneWay,
    reply,
    suppress: oneWay && !legacyOneWayAck,
    transfer
  };
}

export function buildWorkerErrorReply(message, error) {
  return {
    id: message?.id,
    ok: false,
    error: String(error)
  };
}

export function estimateWorkerMessageJsonBytes(message) {
  return new TextEncoder().encode(JSON.stringify(message)).byteLength;
}

export function requestedUpstreamCoreBuild(search = globalThis.location?.search ?? "") {
  const requested = new URLSearchParams(search).get("coreid")?.toLowerCase().replace(/^sha256:/, "") ?? "";
  if (!requested) {
    return {
      coreId: `sha256:${DEFAULT_UPSTREAM_CORE_SHA256}`,
      sha256: DEFAULT_UPSTREAM_CORE_SHA256,
      coreUrl: DEFAULT_UPSTREAM_CORE_URL,
      candidate: false
    };
  }
  if (!SHA256_PATTERN.test(requested)) {
    throw new Error("coreid must be a SHA-256 content hash");
  }
  return {
    coreId: `sha256:${requested}`,
    sha256: requested,
    coreUrl: `./build/core-candidates/${requested}/dolphin-core-upstream.js`,
    candidate: true
  };
}

export async function sha256Hex(bytes) {
  const view = bytes instanceof ArrayBuffer
    ? bytes
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", view);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function verifyUpstreamCoreWasm(coreUrl, expectedSha256, baseUrl = globalThis.location?.href) {
  if (!SHA256_PATTERN.test(expectedSha256 ?? "")) throw new Error("Expected core SHA-256 is invalid");
  const absoluteCoreUrl = new URL(coreUrl, baseUrl).href;
  const wasmUrl = new URL("dolphin-core-upstream.wasm", absoluteCoreUrl).href;
  const response = await fetch(wasmUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`Core WASM fetch returned ${response.status}`);
  const wasmBinary = await response.arrayBuffer();
  const actualSha256 = await sha256Hex(wasmBinary);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Core WASM SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  }
  return { coreUrl: absoluteCoreUrl, wasmUrl, wasmBinary, sha256: actualSha256 };
}

export function sanitizeDiscFileName(name) {
  const fallback = "disc.iso";
  const normalized = String(name || fallback)
    .replace(/[\\/]/g, "_")
    .replace(/[^a-z0-9._ -]/gi, "_")
    .trim();

  if (!normalized || normalized === "." || normalized === "..") {
    return fallback;
  }

  return normalized;
}

export function workerFsDiscPath(name) {
  return `${WORKERFS_MOUNT_DIR}/${sanitizeDiscFileName(name)}`;
}
