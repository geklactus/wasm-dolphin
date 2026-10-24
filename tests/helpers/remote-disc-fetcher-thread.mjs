// A DiscFetcher on a thread of its own, as in the fetch worker, with a fake network:
// each Range request answers in 64-byte chunks (or workerData.chunkSize) a few
// milliseconds apart. Used by remote-disc-fetch.test.mjs and remote-disc-window.test.mjs
// to drive the real Atomics.wait handshake.
import { parentPort, workerData } from "node:worker_threads";

import { DiscFetcher } from "../../src/remote-disc-fetch.js";

const discByte = (o) => (o * 7 + (o >>> 5)) & 0xff;
const requests = [];

async function fetchStream(url, start, end, signal, onChunk) {
  requests.push([start, end]);
  const size = workerData.chunkSize ?? 64;
  for (let pos = start; pos <= end; pos += size) {
    await new Promise((resolve) => setTimeout(resolve, workerData.chunkDelayMs));
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const chunk = new Uint8Array(Math.min(size, end - pos + 1));
    for (let i = 0; i < chunk.length; i++) chunk[i] = discByte(pos + i);
    onChunk(chunk);
  }
  return { status: 206, etag: null, lastModified: null, total: workerData.size };
}

const fetcher = new DiscFetcher({
  url: "http://disc/",
  size: workerData.size,
  blockSize: workerData.blockSize,
  buffer: workerData.buffer,
  layout: workerData.layout,
  fetchStream,
  notifyReady: () => parentPort.postMessage({ type: "ready" }),
  ...(workerData.windowAlign ? { windowAlign: workerData.windowAlign } : {})
});

parentPort.on("message", (message) => {
  if (message?.type === "requests") {
    parentPort.postMessage({ type: "requests", requests });
    return;
  }
  fetcher.handle(message);
});
parentPort.postMessage({ type: "hello" });
