// Static server for dist-web/ — serves the browser host harness with the
// COOP/COEP headers that cross-origin isolation (and thus OPFS sync
// access handles) requires. Loopback only, like the relay.
//
//   node scripts/serve.mjs [--port <n>]     # default 8788

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist-web");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

function portFrom(argv) {
  const idx = argv.indexOf("--port");
  if (idx >= 0 && argv[idx + 1]) {
    const port = Number(argv[idx + 1]);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be 0-65535");
    return port;
  }
  return 8788;
}

const port = portFrom(process.argv.slice(2));

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
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`host-web harness on http://127.0.0.1:${port}/ (dist-web, COOP/COEP on)`);
});
