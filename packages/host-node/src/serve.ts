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

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

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

export interface StaticServerOptions {
  /** Directory to serve (the built UI, e.g. `packages/ui/dist-web`). */
  outDir: string;
  /** Port to listen on; `0` picks a free one. */
  port?: number;
  /** Bind address — loopback by default, like the relay. */
  host?: string;
}

export interface StaticServerHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

/**
 * Serve `outDir` with the cross-origin-isolation headers the browser host
 * needs. Resolves once listening, so callers can print the URL.
 */
export function startStaticServer(options: StaticServerOptions): Promise<StaticServerHandle> {
  const { outDir, port = 8788, host = "127.0.0.1" } = options;
  const server = createServer(async (req, res) => {
    const path = normalize(new URL(req.url ?? "/", "http://localhost").pathname);
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
