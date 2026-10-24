// Dev static server for the app's dist-web/ — a thin wrapper over
// packages/host-node's startStaticServer, which owns the loopback bind and
// the COOP/COEP headers. The CLI's `serve --ui` verb is the other consumer,
// so there is exactly one implementation.
//
// Exported as startAppServer so the browser e2e can mount it on a free port.
//
//   node scripts/serve.mjs [--port <n>]      # default 8788
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startStaticServer } from "../../host-node/src/serve.ts";

const here = dirname(fileURLToPath(import.meta.url));
const defaultOutDir = join(here, "..", "dist-web");

/** Serve a dist-web directory on 127.0.0.1. Resolves once listening. */
export function startAppServer({ port = 8788, outDir = defaultOutDir } = {}) {
  return startStaticServer({ port, outDir, host: "127.0.0.1" });
}

function portFrom(argv) {
  const idx = argv.indexOf("--port");
  if (idx >= 0 && argv[idx + 1]) {
    const port = Number(argv[idx + 1]);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be 0-65535");
    return port;
  }
  return 8788;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = portFrom(process.argv.slice(2));
  const app = await startAppServer({ port });
  console.log(`sure-mail app on http://127.0.0.1:${app.port}/ (dist-web, COOP/COEP on)`);
}
