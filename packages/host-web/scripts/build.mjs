// Browser build: esbuild bundles the host entry and the store worker into
// dist-web/, then copies the two wasm assets next to them (core.wasm for
// the reactor, sqlite3.wasm for the store worker — both resolve at runtime
// relative to their bundle).
//
//   node scripts/build.mjs           # dist-web/{host.js,store-worker.js,...}
//   node scripts/build.mjs --watch   # rebuild on change (no asset copy loop)

import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build, context } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const outDir = join(pkgRoot, "dist-web");
const require = createRequire(import.meta.url);

const common = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
  // OPFS needs cross-origin isolation; the app is served with COOP/COEP.
  supported: { "import-meta": true },
};

const hostEntry = {
  ...common,
  entryPoints: [join(pkgRoot, "src", "index.ts")],
  outfile: join(outDir, "host.js"),
};

const workerEntry = {
  ...common,
  entryPoints: [join(pkgRoot, "src", "store", "worker.ts")],
  outfile: join(outDir, "store-worker.js"),
};

async function copyAssets() {
  const coreWasm = require.resolve("@shing.wong/sure-mail-core/wasm");
  const sqliteWasm = require.resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm");
  // sqlite3.wasm loads relative to the bundle's import.meta.url.
  await cp(coreWasm, join(outDir, "core.wasm"));
  await cp(sqliteWasm, join(outDir, "sqlite3.wasm"));
  // The other OPFS VFSes (opfs / opfs-wl — not the sahpool one we use)
  // spawn this proxy worker, resolved against import.meta.url. Copy it from
  // the wasm asset's dist dir so those VFSes can install without a 404.
  await cp(join(dirname(sqliteWasm), "sqlite3-opfs-async-proxy.js"), join(outDir, "sqlite3-opfs-async-proxy.js"));
  await cp(join(pkgRoot, "web", "index.html"), join(outDir, "index.html"));
}

async function main() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await copyAssets();
  if (process.argv.includes("--watch")) {
    const ctxs = await Promise.all([context(hostEntry), context(workerEntry)]);
    await Promise.all(ctxs.map((ctx) => ctx.watch()));
    console.log("host-web: watching (no livereload)");
    return;
  }
  await Promise.all([build(hostEntry), build(workerEntry)]);
  console.log("host-web: built dist-web/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
