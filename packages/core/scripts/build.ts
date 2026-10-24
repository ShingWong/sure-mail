// Build packages/core: compile the AssemblyScript sources to dist/core.wasm
// with raw JS bindings (dist/core.js + dist/core.d.ts), and the test probes
// entry to dist/probes.wasm. See docs/abi.md for the wasm ABI.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(pkgDir, "dist");
const require = createRequire(import.meta.url);
const ascJs = join(dirname(require.resolve("assemblyscript/package.json")), "bin", "asc.js");

/** Run asc with the package's asconfig; exit non-zero on compile failure. */
function asc(args: string[]): void {
  const r = spawnSync(process.execPath, [ascJs, ...args], { cwd: pkgDir, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`asc failed with status ${r.status ?? "signal " + r.signal}`);
    process.exit(r.status ?? 1);
  }
}

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

// Core module (the ship artifact).
asc(["src/index.ts", "--config", "asconfig.json", "--target", "release"]);

// Test probes entry: compiles the same core sources into diagnostic exports
// used by test/*.test.mjs. Never shipped; lives in dist only.
asc([
  "test/probes/entry.ts",
  "--config", "asconfig.json",
  "--target", "release",
  "--outFile", "dist/probes.wasm",
]);

const expected = [
  "core.wasm", "core.js", "core.d.ts",
  "probes.wasm", "probes.js", "probes.d.ts",
];
for (const file of expected) {
  const path = join(distDir, file);
  if (!existsSync(path)) {
    console.error(`build incomplete: missing dist/${file}`);
    process.exit(1);
  }
  console.log(`dist/${file} (${statSync(path).size} bytes)`);
}
