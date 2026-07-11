#!/usr/bin/env bun
/**
 * Prepares the packaged sidecar: a copy of the `bun` executable itself (renamed
 * with the Rust target-triple suffix Tauri's `externalBin` mechanism requires,
 * see tauri.conf.json `bundle.externalBin`) plus a production install of the
 * server under src-tauri/resources/server (see `bundle.resources`).
 *
 * We deliberately do NOT use `bun build --compile` here: transformers.js's
 * onnxruntime/sharp native and WASM assets don't survive being embedded into a
 * single-file compiled executable (their runtime asset-loading assumes a real
 * filesystem path). Shipping the plain `bun` runtime plus real files sidesteps
 * that entirely and is what Tauri's sidecar mechanism is designed for anyway.
 */
import { mkdirSync, rmSync, cpSync, chmodSync } from "node:fs";
import path from "node:path";

const serverDir = path.dirname(import.meta.dirname);
const rootDir = path.dirname(serverDir);
const tauriDir = path.join(rootDir, "src-tauri");
const binariesDir = path.join(tauriDir, "binaries");
const resourcesServerDir = path.join(tauriDir, "resources", "server");

const triple = new TextDecoder()
  .decode(Bun.spawnSync(["rustc", "--print", "host-tuple"]).stdout)
  .trim();
if (!triple) {
  console.error("Could not determine the Rust target triple (is `rustc` on PATH?).");
  process.exit(1);
}

const bunPath = Bun.which("bun");
if (!bunPath) {
  console.error("Could not find `bun` on PATH.");
  process.exit(1);
}

mkdirSync(binariesDir, { recursive: true });
const sidecarSuffix = process.platform === "win32" ? ".exe" : "";
const sidecarOut = path.join(binariesDir, `pi-desktop-server-${triple}${sidecarSuffix}`);
cpSync(bunPath, sidecarOut);
chmodSync(sidecarOut, 0o755);
console.log(`Sidecar runtime (bun): ${sidecarOut}`);

rmSync(resourcesServerDir, { recursive: true, force: true });
mkdirSync(resourcesServerDir, { recursive: true });
cpSync(path.join(serverDir, "src"), path.join(resourcesServerDir, "src"), { recursive: true });
cpSync(path.join(serverDir, "package.json"), path.join(resourcesServerDir, "package.json"));

const install = Bun.spawnSync(["bun", "install", "--production"], {
  cwd: resourcesServerDir,
  stdout: "inherit",
  stderr: "inherit",
});
if (!install.success) {
  process.exit(install.exitCode ?? 1);
}

console.log(`Bundled server resources: ${resourcesServerDir}`);
