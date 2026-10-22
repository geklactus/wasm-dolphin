// Writes patches/dolphin-wasm/snapshot/*.patch from a branch of vendor/dolphin.
//
// The port is maintained as commits on a branch of the vendor checkout (one commit per
// snapshot patch, subject = the patch's file name without ".patch", e.g.
// "0003-ppc-wasm-jit"), on top of the upstream commit pinned in
// provenance/dolphin-source.lock.json. Rebasing onto a newer Dolphin means rebasing that
// branch, then running this to rewrite the patch files, then
// `npm run update:provenance` to re-lock them.
//
//   node tools/export-dolphin-patches.mjs [--branch wasm-rebase] [--base <commit>]
//
// Each patch is `git format-patch` output with a zeroed commit id, no diffstat and no
// signature, so re-exporting an unchanged commit gives an identical file. Patch files in the
// snapshot directory that the branch no longer produces are deleted.

import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const vendorRoot = resolve(root, "vendor/dolphin");
const snapshotDirectory = resolve(root, "patches/dolphin-wasm/snapshot");
const lock = JSON.parse(readFileSync(resolve(root, "provenance/dolphin-source.lock.json"), "utf8"));

const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const branch = argument("--branch", "wasm-rebase");
const base = argument("--base", lock.upstream.commit);

function git(args, options = {}) {
  const result = spawnSync("git", ["-C", vendorRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.error?.message || "").trim()}`);
  }
  return result.stdout;
}

const commits = git(["rev-list", "--reverse", `${base}..${branch}`]).split("\n").filter(Boolean);
if (commits.length === 0) throw new Error(`No commits between ${base} and ${branch}`);

const written = new Set();
for (const commit of commits) {
  const subject = git(["log", "-1", "--format=%s", commit]).trim();
  if (!/^\d{4}-[a-z0-9][a-z0-9-]*$/.test(subject)) {
    throw new Error(`Commit ${commit.slice(0, 10)} subject "${subject}" is not a patch file name (NNNN-slug)`);
  }
  const name = `${subject}.patch`;
  if (written.has(name)) throw new Error(`Two commits are named ${subject}`);
  const patch = git([
    "format-patch",
    "-1",
    "--stdout",
    "--zero-commit",
    "--no-signature",
    "--no-stat",
    "--no-numbered",
    commit,
  ]);
  writeFileSync(resolve(snapshotDirectory, name), patch);
  written.add(name);
}

const stale = readdirSync(snapshotDirectory)
  .filter((entry) => /^\d{4}-.*\.patch$/.test(entry) && !written.has(entry))
  .sort();
for (const entry of stale) rmSync(resolve(snapshotDirectory, entry));

console.log(JSON.stringify({ branch, base, patches: written.size, removed: stale }, null, 2));
