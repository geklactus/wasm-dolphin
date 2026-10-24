// The fetch worker behind a remote disc: every HTTP Range request for ?disc= is made
// here, so the discio worker can block on a miss while this one parks the background
// requests and fetches the block; where the browser allows two sync handles on one file,
// this worker also writes the copy on this device (remote-disc-fetch.js has the protocol).
import { DiscFetcher, httpFetchStream, openWriterStore } from "./remote-disc-fetch.js";

let fetcher = null;

self.addEventListener("message", async (event) => {
  const message = event.data;
  if (message?.type === "init") {
    await fetcher?.stop();
    fetcher = new DiscFetcher({
      url: message.url,
      size: message.size,
      blockSize: message.blockSize,
      buffer: message.buffer,
      layout: message.layout,
      validators: message.validators,
      fetchStream: httpFetchStream,
      notifyReady: () => self.postMessage({ type: "ready" }),
      post: (reply) => self.postMessage(reply)
    });
    let report = null;
    if (message.store) {
      const storage = self.navigator?.storage;
      const opened = await openWriterStore({
        source: { url: message.url, size: message.size, ...message.store },
        bitmapBytes: new Uint8Array(message.buffer, message.layout.bitmapOffset, message.layout.bitmapBytes),
        getRoot: storage?.getDirectory ? () => storage.getDirectory() : null,
        estimate: storage?.estimate ? () => storage.estimate() : null,
        locks: self.navigator?.locks,
        blockSize: message.blockSize
      });
      fetcher.store = opened.store ?? null;
      report = { ok: opened.ok, writer: opened.writer, reason: opened.reason ?? null, note: opened.note ?? null };
    }
    self.postMessage({ type: "hello", store: report });
    return;
  }
  fetcher?.handle(message);
});
