// The FTS SQL in fts.generated.ts must match what the contract renders today.
//
// The core is AssemblyScript and cannot import the TypeScript renderer, so the
// SQL is generated and committed. That trade means the file can drift from the
// contract — silently, because the committed copy keeps working. This test closes
// that gap by re-rendering and comparing.
//
// It is env-gated like the browser suites: a fresh clone (and CI) has no
// sure-store checkout, so the check is SKIPPED with a stated reason rather than
// passing by never running.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(here, "..");
const REPO = resolve(CORE, "..", "..");
const CONTRACT = resolve(process.env.SURE_STORE_DIR ?? join(REPO, "..", "sure-store"));
const GENERATED = join(CORE, "src", "store", "fts.generated.ts");

const contractPresent = () => existsSync(join(CONTRACT, "contracts", "engines.json"));

/** Run the drift check against a specific file. */
function check(file) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(CORE, "scripts", "render-fts.mjs"), "--check"],
    { encoding: "utf8", env: { ...process.env, SURE_STORE_DIR: CONTRACT, SURE_MAIL_FTS_FILE: file } },
  );
}

/** Write a mutated copy of the generated file and run the check against it. */
function checkCopy(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "sure-mail-fts-"));
  try {
    const copy = join(dir, "fts.generated.ts");
    writeFileSync(copy, mutate(readFileSync(GENERATED, "utf8")));
    return check(copy);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("fts.generated.ts is current with the contract", (t) => {
  if (!existsSync(join(CONTRACT, "contracts", "engines.json"))) {
    t.skip(`no sure-store checkout at ${CONTRACT} — set SURE_STORE_DIR to check drift`);
    return;
  }

  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(CORE, "scripts", "render-fts.mjs"), "--check"],
    { encoding: "utf8", env: { ...process.env, SURE_STORE_DIR: CONTRACT } },
  );

  assert.equal(
    run.status,
    0,
    `generated FTS SQL is stale — run "npm run render:fts" in packages/core:\n${run.stderr ?? ""}`,
  );
});

test("provenance moves without failing the gate", (t) => {
  if (!contractPresent()) {
    t.skip(`no sure-store checkout at ${CONTRACT}`);
    return;
  }
  // Both provenance lines move on a release that changes no dialect fact: the
  // spec version, and the contract revision. Neither is drift.
  const run = checkCopy((s) =>
    s
      .replace(/\(spec \d+\.\d+\.\d+\)/, "(spec 9.9.9)")
      .replace(/^\/\/ Contract revision: .*$/m, "// Contract revision: deadbee"),
  );
  assert.equal(run.status, 0, `provenance-only change should pass:\n${run.stderr ?? ""}`);
});

test("a changed statement still fails the gate", (t) => {
  if (!contractPresent()) {
    t.skip(`no sure-store checkout at ${CONTRACT}`);
    return;
  }
  // The half that must never soften: the SQL itself is compared.
  const run = checkCopy((s) => s.replace("USING fts5(", "USING fts4("));
  assert.equal(run.status, 1, "a changed statement must fail the drift check");
  assert.match(run.stderr ?? "", /stale/);
});
