// An in-memory stand-in for the origin-private file system: directory and file handles,
// sync access handles with the exclusive lock, and an operation log so tests can check
// the order of writes and flushes. Faults are switched on per file.

function domError(name, message = name) {
  return new DOMException(message, name);
}

class FakeSyncAccessHandle {
  constructor(file, mode) {
    this.file = file;
    this.closed = false;
    if (mode) this.mode = mode;
  }

  check() {
    if (this.closed) throw domError("InvalidStateError", "handle is closed");
  }

  getSize() {
    this.check();
    return this.file.size;
  }

  read(view, { at = 0 } = {}) {
    this.check();
    if (this.file.failRead) throw domError("NotReadableError");
    const end = Math.min(this.file.size, at + view.length);
    if (end <= at) return 0;
    const bytes = this.file.bytes(at, end);
    view.set(bytes);
    this.file.root.log.push(["read", this.file.name, at, bytes.length]);
    return bytes.length;
  }

  write(view, { at = 0 } = {}) {
    this.check();
    if (this.file.failWrite) return 0xfffffff8;      // what Chromium's broken backend returned
    this.file.writeAt(at, view);
    this.file.root.log.push(["write", this.file.name, at, view.length]);
    return view.length;
  }

  truncate(size) {
    this.check();
    if (this.file.quota != null && size > this.file.quota) throw domError("QuotaExceededError");
    if (this.file.silentTruncate) return;            // Chromium's in-memory backend: "ok", size unchanged
    this.file.resize(size);
    this.file.root.log.push(["truncate", this.file.name, size]);
  }

  flush() {
    this.check();
    this.file.root.log.push(["flush", this.file.name]);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.mode === "readwrite-unsafe") this.file.shared -= 1;
    else this.file.locked = false;
  }
}

class FakeFile {
  constructor(root, name) {
    this.root = root;
    this.name = name;
    this.data = new Uint8Array(0);
    this.size = 0;
    this.locked = false;
    this.shared = 0;
    this.failRead = false;
    this.failWrite = false;
    this.silentTruncate = false;
    this.quota = null;
    this.lockError = null;
  }

  resize(size) {
    if (size > this.data.length) {
      const grown = new Uint8Array(Math.max(size, this.data.length * 2));
      grown.set(this.data.subarray(0, this.size));
      this.data = grown;
    } else {
      this.data.fill(0, size, this.size);
    }
    this.size = size;
  }

  writeAt(at, view) {
    if (at + view.length > this.size) this.resize(at + view.length);
    this.data.set(view, at);
  }

  bytes(start = 0, end = this.size) {
    return this.data.slice(start, Math.min(end, this.size));
  }
}

class FakeFileHandle {
  constructor(file) {
    this.kind = "file";
    this.name = file.name;
    this.file = file;
  }

  // Modes as Chromium has them: "readwrite-unsafe" handles coexist with each other, an
  // exclusive one with nothing. root.sharedModes = false is a browser that ignores the
  // option (and hands out an exclusive handle with no mode).
  async createSyncAccessHandle(options = {}) {
    if (this.file.lockError) throw domError(this.file.lockError);
    const shared = options?.mode === "readwrite-unsafe" && this.file.root.sharedModes !== false;
    if (this.file.locked || (!shared && this.file.shared > 0)) throw domError("NoModificationAllowedError", "the file is locked");
    if (shared) {
      this.file.shared += 1;
      return new FakeSyncAccessHandle(this.file, "readwrite-unsafe");
    }
    this.file.locked = true;
    return new FakeSyncAccessHandle(this.file);
  }

  async getFile() {
    const snapshot = this.file.bytes();
    const make = (bytes) => ({
      size: bytes.length,
      async text() { return new TextDecoder().decode(bytes); },
      async arrayBuffer() { return bytes.slice().buffer; },
      slice(a = 0, b = bytes.length) { return make(bytes.slice(a, b)); }
    });
    return make(snapshot);
  }
}

export class FakeDirectory {
  constructor(name = "", root = null) {
    this.kind = "directory";
    this.name = name;
    this.root = root ?? this;
    this.children = new Map();
    if (!root) this.log = [];
  }

  async getDirectoryHandle(name, { create = false } = {}) {
    let child = this.children.get(name);
    if (!child) {
      if (!create) throw domError("NotFoundError");
      child = new FakeDirectory(name, this.root);
      this.children.set(name, child);
    }
    if (!(child instanceof FakeDirectory)) throw domError("TypeMismatchError");
    return child;
  }

  async getFileHandle(name, { create = false } = {}) {
    let child = this.children.get(name);
    if (!child) {
      if (!create) throw domError("NotFoundError");
      child = new FakeFile(this.root, name);
      this.children.set(name, child);
    }
    if (!(child instanceof FakeFile)) throw domError("TypeMismatchError");
    return new FakeFileHandle(child);
  }

  async removeEntry(name) {
    const child = this.children.get(name);
    if (!child) throw domError("NotFoundError");
    if (child instanceof FakeFile && (child.locked || child.shared > 0)) throw domError("NoModificationAllowedError");
    this.children.delete(name);
  }

  async *keys() {
    for (const name of [...this.children.keys()]) yield name;
  }

  // Test helpers (not part of the real API).
  file(name) {
    return this.children.get(name) ?? null;
  }

  dir(name) {
    return this.children.get(name) ?? null;
  }
}

// navigator.locks, as far as { ifAvailable: true } needs it.
export class FakeLocks {
  constructor() {
    this.held = new Set();
  }

  async request(name, options, callback) {
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try {
      return await callback({ name });
    } finally {
      this.held.delete(name);
    }
  }
}
