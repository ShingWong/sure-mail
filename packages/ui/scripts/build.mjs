// Build the sure-mail app (packages/ui) into dist-web/: the app bundle, the
// store worker (bundled from the host-web package's worker entry — one
// implementation, no fork), the wasm assets both bundles load at runtime, and
// the document shell.
//
//   node scripts/build.mjs            # dist-web/{app.js,store-worker.js,…}
//   node scripts/build.mjs --watch    # rebuild on change (no asset copy loop)
//
// The skin CSS is not built here: composeSkin() runs in the browser from the
// bundled sure-ui, so every skin is a runtime-swappable string.
import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  supported: { "import-meta": true },
};

const appEntry = {
  ...common,
  entryPoints: [join(pkgRoot, "src", "app", "main.ts")],
  outfile: join(outDir, "app.js"),
};

// Resolve the host-web package's source entry, then its worker sibling.
const hostWebEntry = require.resolve("@shing.wong/sure-mail-host-web");
const storeWorkerEntry = join(dirname(hostWebEntry), "store", "worker.ts");

const workerEntry = {
  ...common,
  entryPoints: [storeWorkerEntry],
  outfile: join(outDir, "store-worker.js"),
};

async function copyAssets() {
  const coreWasm = require.resolve("@shing.wong/sure-mail-core/wasm");
  const sqliteWasm = require.resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm");
  await cp(coreWasm, join(outDir, "core.wasm"));
  await cp(sqliteWasm, join(outDir, "sqlite3.wasm"));
  // The OPFS VFSes spawn this proxy worker relative to sqlite3.wasm's URL.
  await cp(join(dirname(sqliteWasm), "sqlite3-opfs-async-proxy.js"), join(outDir, "sqlite3-opfs-async-proxy.js"));
  await cp(join(pkgRoot, "web", "index.html"), join(outDir, "index.html"));
}

async function main() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await copyAssets();
  if (process.argv.includes("--watch")) {
    const ctxs = await Promise.all([context(appEntry), context(workerEntry)]);
    await Promise.all(ctxs.map((ctx) => ctx.watch()));
    console.log("sure-mail app: watching (no livereload)");
    return;
  }
  await Promise.all([build(appEntry), build(workerEntry)]);
  console.log("sure-mail app: built dist-web/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
