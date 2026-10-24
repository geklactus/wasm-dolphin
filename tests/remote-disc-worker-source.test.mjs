import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

function extractFunction(source, name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(source);
  assert.ok(match, `missing production function ${name}`);
  const end = source.indexOf("\n}", match.index);
  return source.slice(match.index, end + 2);
}

test("the worker mounts a posted ?disc= source through a RangeDisc and a range-aware reader", () => {
  assert.match(worker, /import \{ loadReadOrder, openRangeDisc \} from "\.\/remote-disc\.js";/);
  assert.match(extractFunction(worker, "openRemoteDisc"), /loadOrder: \(disc\) => loadReadOrder\(disc\),/, "the read order beside the disc");
  assert.match(worker, /import \{ createDiscFetcher \} from "\.\/remote-disc-fetch\.js";/);
  const mount = extractFunction(worker, "mountFile");
  assert.match(mount, /if \(file\.url\) \{\s*data = await openRemoteDisc\(file, \{ gameRunning: true \}\);\s*installRangeAwareReader\(workerFs\);/);
  assert.match(mount, /fs\.mount\(workerFs, \{ blobs: \[\{ name: safeName, data \}\] \}, WORKERFS_MOUNT_DIR\);/);
  assert.ok(mount.indexOf("fs.unmount(WORKERFS_MOUNT_DIR)") < mount.indexOf("openRemoteDisc"), "the old mount goes first");
  for (const type of ["discPrepare", "discStats", "discRemove", "discFlush", "discReads"]) {
    assert.match(worker, new RegExp(`case "${type}":`), type);
  }
});

test("the reader shim passes a RangeDisc slice through and leaves a real File to FileReaderSync", () => {
  const context = {
    Blob: class Blob {},
    FileReaderSync: class { readAsArrayBuffer(blob) { return `read:${blob.name}`; } }
  };
  vm.createContext(context);
  vm.runInContext(`${extractFunction(worker, "installRangeAwareReader")}; this.install = installRangeAwareReader;`, context);
  const workerFs = { reader: null };
  context.install(workerFs);
  const shim = workerFs.reader;
  assert.equal(shim.rangeAware, true);
  const slice = { size: 3, buffer: new ArrayBuffer(3) };
  assert.equal(shim.readAsArrayBuffer(slice), slice.buffer);
  const blob = Object.assign(new context.Blob(), { name: "disc.iso" });
  assert.equal(shim.readAsArrayBuffer(blob), "read:disc.iso");
  context.install(workerFs);
  assert.equal(workerFs.reader, shim, "installed once");
});

test("a failed remote read reaches Dolphin as EIO", () => {
  const statuses = [];
  class ErrnoError { constructor(errno) { this.errno = errno; this.name = "ErrnoError"; } }
  const context = { moduleInstance: { FS: { ErrnoError } }, postStatus: (m) => statuses.push(m) };
  vm.createContext(context);
  vm.runInContext(`${extractFunction(worker, "remoteDiscReadError")}; this.toErrno = remoteDiscReadError;`, context);
  const error = context.toErrno(new Error("disc block 7: HTTP 503"));
  assert.equal(error.errno, 29);
  assert.equal(error.name, "ErrnoError");
  assert.match(statuses[0], /disc block 7: HTTP 503/);
});

test("the same URL reuses the open disc (prepared before the boot); another closes it first", async () => {
  const opened = [];
  const context = {
    remoteDisc: null,
    self: { navigator: { storage: null } },
    console: { log() {} },
    createDiscFetcher: () => ({}),
    remoteDiscReadError: (e) => e,
    openRangeDisc: async (source, options) => {
      const disc = {
        url: source.url, closed: false, gameRunning: false, options,
        setGameRunning(on) { this.gameRunning = on; },
        async close() { this.closed = true; }
      };
      opened.push(disc);
      return disc;
    }
  };
  vm.createContext(context);
  vm.runInContext(`${extractFunction(worker, "openRemoteDisc")}; this.open = openRemoteDisc; this.current = () => remoteDisc;`, context);
  const prepared = await context.open({ url: "http://h/disc/a.rvz", prefetch: false, opfs: true }, { gameRunning: false });
  assert.equal(prepared.gameRunning, false, "a prepared disc downloads at full speed");
  assert.equal(prepared.options.prefetch, false, "?prefetch=0 travels with the disc");
  assert.equal(prepared.options.opfs, true);
  const booted = await context.open({ url: "http://h/disc/a.rvz" }, { gameRunning: true });
  assert.equal(booted, prepared);
  assert.equal(booted.gameRunning, true, "and is held to the cap once the game runs");
  const other = await context.open({ url: "http://h/disc/b.rvz", opfs: false }, { gameRunning: true });
  assert.equal(prepared.closed, true);
  assert.equal(other.options.opfs, false, "?opfs=0 travels with the disc");
  assert.equal(context.current(), other);
  assert.equal(opened.length, 2);
});

test("the page passes ?disc= on with its validators and flags, and has the panel's controls", () => {
  assert.match(app, /readRemoteDiscFlags\(window\.location\.search\)/);
  assert.match(app, /etag: response\.headers\.get\("ETag"\)/);
  assert.match(app, /lastModified: response\.headers\.get\("Last-Modified"\)/);
  assert.match(app, /\.\.\.flags/);
  assert.match(app, /host\.prepareRemoteDisc\(disc\)/);
  assert.match(app, /host\.discRequest\("discRemove"\)/);
  assert.match(app, /navigator\.storage\.persist\(\)/);
  assert.match(app, /DISC_PERSIST_ASKED_KEY/);
  for (const id of ["discCache", "discCacheNote", "discNetNote", "discDownloadFirst", "discRemoveButton", "discLibrary", "discLibraryList"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /Download fully before starting/);
  assert.match(html, /Remove from this device/);
});
