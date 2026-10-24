// Lint packages/core: type-check the AssemblyScript sources with asc
// (the AS analogue of tsc --noEmit — the TS-side scripts are checked by
// tsc in the lint npm script).
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const pkgDir = join(dirname(new URL(import.meta.url).pathname), "..");
const require = createRequire(import.meta.url);
const ascJs = join(dirname(require.resolve("assemblyscript/package.json")), "bin", "asc.js");

const entries = ["src/index.ts", "test/probes/entry.ts"];
let failed = false;
for (const entry of entries) {
  const r = spawnSync(
    process.execPath,
    [ascJs, entry, "--config", "asconfig.json", "--target", "release", "--noEmit", "--noColors"],
    { cwd: pkgDir, stdio: "inherit" },
  );
  if (r.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
