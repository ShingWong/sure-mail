// Static file server for a built UI directory.
//
// One implementation, two consumers — the CLI's `serve --ui` verb (the local
// client, D17) and `packages/ui/scripts/serve.mjs` (the dev harness the
// browser e2e mounts on a free port). Duplicating it is exactly the drift
// D15/D16 were about.
//
// The headers are the load-bearing part: cross-origin isolation
// (COOP + COEP) is what gives the page OPFS sync access handles and
// SharedArrayBuffer. Without it the store worker cannot persist.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, normalize } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

export interface UpdateManifest {
  version: string;
  tag: string;
  notes?: string;
  assets: Record<string, { build: string; url: string; sha256: string; size: number }>;
}

export interface UpdateOptions {
  /** The running build stamp, e.g. "0.1.0 (build d169369a1871)". */
  current: string;
  /** Manifest location. Defaults to the published manifest. */
  manifestUrl?: string;
}

export interface StaticServerOptions {
  /** Directory to serve (the built UI, e.g. `packages/ui/dist-web`). */
  outDir: string;
  /** Port to listen on; `0` picks a free one. */
  port?: number;
  /** Bind address — loopback by default, like the relay. */
  host?: string;
  /** Enables `GET /__update` (check) and `POST /__update/download`. */
  update?: UpdateOptions;
}

const DEFAULT_MANIFEST = "https://positronic-ai.us/downloads/sure-mail/latest.json";

/** The asset key for this machine, e.g. "win32-x64". */
function assetKey(): string {
  return `${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
}

/** Everything the UI needs to say "you are on build X, latest is Y". */
export async function checkUpdate(options: UpdateOptions): Promise<Record<string, unknown>> {
  const key = assetKey();
  const currentBuild = /build ([0-9a-f]+)/i.exec(options.current)?.[1] ?? "";
  try {
    const res = await fetch(options.manifestUrl ?? DEFAULT_MANIFEST, {
      signal: AbortSignal.timeout(8000),
      headers: { "cache-control": "no-cache" },
    });
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
    const manifest = (await res.json()) as UpdateManifest;
    const asset = manifest.assets?.[key];
    if (!asset) {
      return { ok: false, current: options.current, error: `no build published for ${key}` };
    }
    return {
      ok: true,
      current: options.current,
      currentBuild,
      latest: { version: manifest.version, build: asset.build, tag: manifest.tag, notes: manifest.notes ?? "", size: asset.size },
      available: asset.build !== currentBuild,
    };
  } catch (err) {
    return { ok: false, current: options.current, error: String(err instanceof Error ? err.message : err) };
  }
}

export interface StaticServerHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

/**
 * Replace the running executable with the latest verified payload, then relaunch.
 *
 * The swap cannot happen in this process: on Windows a running image cannot be
 * overwritten (it can be renamed, which is how the helper does it). So the
 * downloaded build is started with `--apply-update <pid> <target>`; it waits for
 * this process to exit, swaps, and starts the new build with the same arguments.
 * The previous build stays beside the target as `<name>.old`, so a bad update is
 * a rename away from undone.
 */
export async function applyUpdate(options: UpdateOptions): Promise<Record<string, unknown>> {
  const downloaded = await downloadUpdate(options);
  if (!downloaded.ok) return downloaded;
  const target = process.execPath;
  const relaunch = process.argv.slice(2);
  const child = spawn(
    String(downloaded.path),
    ["apply-update", String(process.pid), target, "--relaunch", ...relaunch],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  return { ok: true, restarting: true, path: downloaded.path, target };
}

/**
 * Download this platform's latest payload, verifying its sha256.
 *
 * It lands in the user's Downloads folder rather than replacing the running
 * executable: on Windows a process cannot overwrite its own image, so applying
 * an update needs a restart (or a helper that waits for exit). Telling someone
 * where the file is, with a hash that matches, is honest; replacing their app
 * behind their back is not something a first version should do.
 */
export async function downloadUpdate(options: UpdateOptions): Promise<Record<string, unknown>> {
  const info = await checkUpdate(options);
  const asset = (info.latest ?? null) as { build: string; tag?: string; size?: number } | null;
  if (!info.ok || !asset) return { ok: false, error: String(info.error ?? "no update information") };

  const manifest = (await (await fetch(options.manifestUrl ?? DEFAULT_MANIFEST, {
    signal: AbortSignal.timeout(8000),
  })).json()) as UpdateManifest;
  const entry = manifest.assets[assetKey()];
  if (!entry) return { ok: false, error: `no build published for ${assetKey()}` };

  const dir = join(homedir(), "Downloads");
  await mkdir(dir, { recursive: true });
  const name = `sure-mail-${asset.build}${process.platform === "win32" ? ".exe" : ""}`;
  const target = join(dir, name);

  const res = await fetch(entry.url, { signal: AbortSignal.timeout(600000) });
  if (!res.ok || !res.body) return { ok: false, error: `download HTTP ${res.status}` };

  const hash = createHash("sha256");
  const out = createWriteStream(target);
  let bytes = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    bytes += chunk.length;
    hash.update(chunk);
    if (!out.write(chunk)) {
      await new Promise<void>((r) => out.once("drain", () => r()));
    }
  }
  await new Promise<void>((r) => out.end(() => r()));
  const digest = hash.digest("hex");
  if (digest !== entry.sha256) {
    const { rm } = await import("node:fs/promises");
    await rm(target, { force: true });
    return { ok: false, error: `checksum mismatch (got ${digest.slice(0, 12)}…, expected ${entry.sha256.slice(0, 12)}…)` };
  }
  // On Linux an executable arrives without the bit set; a downloaded update
  // that cannot be run is a support ticket.
  if (process.platform !== "win32") {
    const { chmod } = await import("node:fs/promises");
    await chmod(target, 0o755);
  }
  const size = (await stat(target)).size;
  return { ok: true, path: target, bytes, size, build: asset.build, sha256: digest, name: basename(target) };
}

/**
 * Serve `outDir` with the cross-origin-isolation headers the browser host
 * needs. Resolves once listening, so callers can print the URL.
 */
export function startStaticServer(options: StaticServerOptions): Promise<StaticServerHandle> {
  const { outDir, port = 8788, host = "127.0.0.1" } = options;
  const server = createServer(async (req, res) => {
    const path = normalize(new URL(req.url ?? "/", "http://localhost").pathname);

    // Update endpoints. The page cannot replace a file or start a process, so
    // the host does it; these are loopback-only with the server and require a
    // custom header, which a cross-origin form cannot set.
    if (path === "/__update" || path === "/__update/download" || path === "/__update/apply") {
      if (!options.update) {
        res.writeHead(404).end("not found");
        return;
      }
      if (req.method === "POST" && req.headers["x-sure-mail"] !== "1") {
        res.writeHead(403).end("forbidden");
        return;
      }
      try {
        if (path === "/__update") {
          const info = await checkUpdate(options.update);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify(info));
          return;
        }
        const result =
          path === "/__update/apply" ? await applyUpdate(options.update) : await downloadUpdate(options.update);
        res.writeHead(result.ok ? 200 : 500, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(result));
        // Only after the response has flushed: this process owns the image being
        // replaced, so it has to be gone before the helper can swap it.
        if (path === "/__update/apply" && result.ok) {
          setTimeout(() => process.exit(0), 400).unref();
        }
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: String(err instanceof Error ? err.message : err) }));
      }
      return;
    }
    const file = path === "/" || path === "\\" ? "index.html" : path.replace(/^[/\\]/, "");
    if (file.includes("..")) {
      res.writeHead(400).end("bad path");
      return;
    }
    try {
      const body = await readFile(join(outDir, file));
      res.writeHead(200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        // Cross-origin isolation: required for OPFS sync access handles.
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": "require-corp",
        // The UI's asset names are fixed and overwritten in place by a build.
        "cache-control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const bound = server.address();
      const actual = typeof bound === "object" && bound !== null ? bound.port : port;
      resolve({
        port: actual,
        url: `http://${host}:${actual}/`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
