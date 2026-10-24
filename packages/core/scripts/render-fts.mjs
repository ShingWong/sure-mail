// Render sure-mail's FTS SQL from the sure-store contract.
//
// Why a generator and not a dependency: the core is AssemblyScript, so it cannot
// import the TypeScript reference renderer at runtime. Generated SQL is the only
// bridge, and it matches the repository's rule that generated code lives apart
// from hand-written code and is never edited by hand.
//
//   SURE_STORE_DIR=<path> node --experimental-strip-types scripts/render-fts.mjs
//   node --experimental-strip-types scripts/render-fts.mjs --check
//
// --check re-renders and compares without writing; exit 2 means the contract
// checkout is absent (the caller may skip), exit 1 means drift.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const REPO_ROOT = resolve(ROOT, "..", "..");
const OUT = join(ROOT, "src", "store", "fts.generated.ts");
const CONTRACT_DIR = resolve(process.env.SURE_STORE_DIR ?? join(REPO_ROOT, "..", "sure-store"));
const CHECK = process.argv.includes("--check");

// The shape sure-mail uses. Changing any of these changes the rendered SQL, so
// they are the whole interface between the core and the contract.
const NAME = "messages_fts";
const TABLE = "messages";
const COLS = ["subject", "fromaddr", "body_text"];
const SELECT = "m.uid, m.folder, m.subject, m.fromaddr, m.internaldate";
const ORDER_BY = "m.internaldate";

if (!existsSync(join(CONTRACT_DIR, "contracts", "engines.json"))) {
  console.error(
    `render-fts: no sure-store checkout at ${CONTRACT_DIR}\n` +
      "Set SURE_STORE_DIR to the repository, or use the committed generated file.",
  );
  process.exit(2);
}

const mod = await import(pathToFileURL(join(CONTRACT_DIR, "impl", "ts", "index.ts")).href);
const engineName = process.env.SURE_MAIL_FTS_ENGINE ?? "sqlite";
const engine = mod.getEngine(mod.loadContracts(), engineName);

const opts = { name: NAME, table: TABLE, cols: COLS };
const ddl = mod.renderFtsDdl(engine, opts);
const triggers = mod.renderFtsTriggers(engine, opts);

// The core must emit no runtime sync statements: sqlite declares
// `sync: "triggers"`, so the schema owns upkeep. If this ever returns something,
// sure-mail would double-maintain the index.
const sync = mod.ftsSyncStatements(engine, {
  ...opts,
  idPredicate: "account = ? AND folder = ? AND uid = ?",
});
if (sync.length !== 0) {
  console.error(`render-fts: ${engineName} declares ${sync.length} core sync statement(s) — expected 0`);
  process.exit(1);
}

const search = mod.renderSearch(engine, {
  ...opts,
  select: SELECT,
  orderBy: ORDER_BY,
  // Terms and limit only fill `params`; the SQL is the template. The core builds
  // its own MATCH expression from user input.
  terms: ["term"],
  limit: 100,
});
if ((search.sql.match(/\?/g) ?? []).length !== 2) {
  console.error(`render-fts: expected 2 placeholders in the search template, got: ${search.sql}`);
  process.exit(1);
}

/** A commit hash or "unknown" — never a filesystem path (the leak gate forbids those). */
const revision = (() => {
  try {
    return execFileSync("git", ["-C", CONTRACT_DIR, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
})();

const schemaSql =
  [ddl.join(";\n"), triggers.join(";\n")].filter((s) => s.length > 0).join(";\n") + ";";
const literal = (s) => JSON.stringify(s);

const file = `// GENERATED FILE — do not edit by hand.
//
// Source:  @shing.wong/sure-store contracts/engines.json (spec ${mod.specVersion()})
// Engine:  ${engineName}
// Contract revision: ${revision}
//
// Regenerate:
//   SURE_STORE_DIR=<path> node --experimental-strip-types scripts/render-fts.mjs
//
// This is the bridge between the contract and the AssemblyScript core: the core
// cannot import the TypeScript renderer, so the SQL it emits is rendered here and
// checked in. \`scripts/render-fts.mjs --check\` fails when this file drifts.

/** The engine these statements were rendered for. */
export const FTS_ENGINE: string = ${literal(engineName)};

/**
 * The search index schema: the virtual table plus whatever upkeep the engine
 * declares. sqlite declares trigger-owned upkeep, so this is the table followed
 * by the insert/delete/update trigger trio; an engine that maintains its own
 * index would render only the table.
 */
export const FTS_SCHEMA_SQL: string = ${literal(schemaSql)};

/**
 * Search template. The first placeholder is the MATCH expression (built by the
 * core from user input), the second is the limit.
 */
export const FTS_SEARCH_SQL: string = ${literal(search.sql)};
`;

if (CHECK) {
  // Which file to compare against. Defaults to the committed one; the drift test
  // points this at a temporary copy to prove both directions of the gate.
  const target = process.env.SURE_MAIL_FTS_FILE ?? OUT;
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  // Compare what is RENDERED, not where it was rendered from.
  //
  // EVERY provenance line is metadata, and every one of them moves without the
  // SQL moving: the revision hash on any contract commit, and the spec version on
  // any release — including a release that changes no dialect fact. Stripping
  // only the revision line made every contract release fail this gate with
  // byte-identical SQL, which is how a gate becomes an alarm nobody reads.
  //
  // Real drift still fails: the statements themselves are compared, and so is
  // the rest of the generated code.
  const strip = (s) =>
    s.replace(/^\/\/ (Source|Engine|Contract revision):.*$/gm, "// <provenance>");
  if (strip(current) !== strip(file)) {
    console.error("render-fts: fts.generated.ts is stale — re-run without --check");
    process.exit(1);
  }
  console.log(`render-fts: generated file is current (${engineName}, contract ${revision})`);
  process.exit(0);
}

writeFileSync(OUT, file);
console.log(`render-fts: wrote ${OUT}`);
console.log(`  engine ${engineName}, contract ${revision}, ${ddl.length} ddl + ${triggers.length} trigger statement(s)`);
