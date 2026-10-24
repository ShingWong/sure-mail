// Package sure-mail as one executable for this platform (D18, step 1).
//
// The architecture already did the hard part: no native code to port, a 2.3 MB
// UI and a 205 KB core. What has to be built per OS is a **launcher** — so this
// script bundles the CLI, embeds the UI as SEA assets, and injects both into a
// copy of the node binary. The result is a single file:
//
//     ./dist/sure-mail
//
// Double-click (or run with no arguments): it extracts the UI to a cache
// directory, starts `serve --ui`, and opens the browser. Every other verb
// passes through untouched.
//
//   node scripts/package.mjs [--out <path>]
//
// Requires `npm run build:web` first (dist-web) and `postject` (devDependency).

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const UI_DIR = join(ROOT, "packages", "ui", "dist-web");
const CLI = join(ROOT, "packages", "cli", "src", "sure-mail.ts");
const WORK = join(here, ".sea");
const DIST = join(ROOT, "dist");

const outFlag = process.argv.indexOf("--out");
const EXE = process.platform === "win32" ? "sure-mail.exe" : "sure-mail";
const OUT = outFlag > -1 ? resolve(process.argv[outFlag + 1]) : join(DIST, EXE);

// --- preconditions ---------------------------------------------------------

if (!existsSync(join(UI_DIR, "index.html"))) {
  console.error(`package: no built UI at ${UI_DIR} — run \`npm run build:web\` first`);
  process.exit(1);
}
for (const f of ["app.js", "core.wasm", "store-worker.js"]) {
  if (!existsSync(join(UI_DIR, f))) {
    console.error(`package: ${f} missing from ${UI_DIR} — run \`npm run build:web\``);
    process.exit(1);
  }
}

// --- assets: the UI, minus sourcemaps --------------------------------------

// The UI is what the page needs at runtime. Sourcemaps are developer tools and
// would double the payload for nothing.
const uiFiles = readdirSync(UI_DIR)
  .filter((f) => statSync(join(UI_DIR, f)).isFile() && !f.endsWith(".map"))
  .sort();

const CORE = join(ROOT, "packages", "core", "dist", "core.wasm");
if (!existsSync(CORE)) {
  console.error(`package: no ${CORE} — run \`npm run build\` first`);
  process.exit(1);
}

const uiHash = createHash("sha256");
for (const f of uiFiles) uiHash.update(f).update(readFileSync(join(UI_DIR, f)));
uiHash.update(readFileSync(CORE));
const UI_VERSION = uiHash.digest("hex").slice(0, 12);

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

// --- the launcher prelude --------------------------------------------------
//
// Runs before the CLI's own main(). It only acts inside a SEA build: from the
// repository, `node src/sure-mail.ts` must behave exactly as before.

const prelude = `
// ---- sure-mail launcher (SEA only) ----------------------------------------
if (require("node:sea").isSea()) {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  const { spawn } = require("node:child_process");

  const UI_VERSION = ${JSON.stringify(UI_VERSION)};
  const UI_FILES = ${JSON.stringify(uiFiles)};

  // A user who double-clicks this should not meet a stack of Node-internal
  // warnings. Keep real warnings; drop the two that are ours by construction:
  // node:sqlite is experimental and SEA is experimental, and neither is
  // something the person running a mail client can act on.
  process.removeAllListeners("warning");
  process.on("warning", (w) => {
    if (w.name === "ExperimentalWarning" && /SQLite|single executable/i.test(String(w.message))) return;
    console.error((w.name || "Warning") + ": " + w.message);
  });

  const args = process.argv.slice(2);
  const first = args[0];
  const passthrough =
    first !== undefined &&
    (first === "--help" || first === "-h" || first === "--version" || first === "-v" ||
     !first.startsWith("-"));

  // Materialise the UI and core for EVERY run, not only the double-click path:
  // verbs such as doctor, sync and send instantiate core.wasm, and a single
  // binary has no node_modules to resolve it from. Cached by build hash, so
  // this is a directory check after the first run.
  const base =
    process.platform === "win32"
      ? (process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"))
      : (process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"));
  const uiDir = path.join(base, "sure-mail", "ui-" + UI_VERSION);

  if (!fs.existsSync(path.join(uiDir, "index.html"))) {
    const tmp = uiDir + ".tmp-" + process.pid;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    for (const name of UI_FILES) {
      fs.writeFileSync(path.join(tmp, name), Buffer.from(require("node:sea").getAsset("ui/" + name)));
    }
    fs.rmSync(uiDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(uiDir), { recursive: true });
    fs.renameSync(tmp, uiDir);
  }

  // The host asks for this before it can do anything CPU-bound. Without it the
  // binary only works from a checkout that happens to have node_modules — which
  // is exactly how this shipped once, briefly.
  const corePath = path.join(path.dirname(uiDir), "core.wasm");
  if (!fs.existsSync(corePath)) {
    fs.mkdirSync(path.dirname(corePath), { recursive: true });
    fs.writeFileSync(corePath, Buffer.from(require("node:sea").getAsset("core/core.wasm")));
  }
  process.env.SURE_MAIL_CORE_WASM = corePath;

  if (!passthrough) {
    const portAt = args.indexOf("--port");
    const port = portAt > -1 ? Number(args[portAt + 1]) : 8788;
    const noOpen = args.includes("--no-open");
    const rest = args.filter((a) => a !== "--no-open");

    if (!noOpen) {
      // Give the static server a moment to bind before the browser asks.
      setTimeout(() => {
        const url = "http://127.0.0.1:" + port + "/";
        const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
        const argv = process.platform === "win32" ? ["/c", "start", "", url] : [url];
        try {
          spawn(cmd, argv, { detached: true, stdio: "ignore" }).unref();
        } catch {
          // Opening a browser is a courtesy; failing to is not fatal.
          console.error("sure-mail: could not open a browser — the URL is " + url);
        }
      }, 700);
    }

    process.argv = [process.argv[0], process.argv[1], "serve", "--ui", "--ui-dir", uiDir, ...rest];
  }
}
// ---- end launcher ---------------------------------------------------------
`;

// --- bundle (CJS: Node 22's SEA has no ESM entry) --------------------------

const bundle = join(WORK, "cli.cjs");
await build({
  entryPoints: [CLI],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  logLevel: "warning",
  // The CLI reads import.meta.url in a couple of places to find repo-relative
  // defaults. In a SEA those defaults are wrong anyway (the launcher always
  // passes --ui-dir), but the expression must not be empty: point it at the
  // executable.
  define: { "import.meta.url": "__seaImportMetaUrl" },
  banner: {
    js: `const __seaImportMetaUrl = require("node:url").pathToFileURL(process.execPath).href;\n${prelude}`,
  },
});

// --- SEA config + injection ------------------------------------------------

const seaConfig = join(WORK, "sea-config.json");
const blob = join(WORK, "prep.blob");
writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: bundle,
      output: blob,
      disableExperimentalSEAWarning: true,
      assets: {
        ...Object.fromEntries(uiFiles.map((f) => [`ui/${f}`, join(UI_DIR, f)])),
        // The CLI's own copy: doctor, sync and send instantiate it, and there is
        // no node_modules beside a single binary to resolve it from.
        "core/core.wasm": CORE,
      },
    },
    null,
    2,
  ),
);

execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });

mkdirSync(DIST, { recursive: true });
rmSync(OUT, { force: true });
cpSync(process.execPath, OUT);
// Resolve postject's CLI and run it with this same node, rather than the
// node_modules/.bin shim: on Windows that shim is postject.cmd, which an
// execFileSync cannot run without a shell.
const require = createRequire(import.meta.url);
const postjectCli = join(dirname(require.resolve("postject/package.json")), "dist", "cli.js");
execFileSync(
  process.execPath,
  [
    postjectCli,
    OUT,
    "NODE_SEA_BLOB",
    blob,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ],
  { stdio: "inherit" },
);
if (process.platform !== "win32") execFileSync("chmod", ["+x", OUT]);

const size = statSync(OUT).size;
console.log(`\npackaged ${OUT}`);
console.log(
  `  ${(size / 1024 / 1024).toFixed(1)} MB · node ${process.version} · UI ${UI_VERSION} (${uiFiles.length} files)`,
);
console.log("  run with no arguments to start the client and open a browser");
