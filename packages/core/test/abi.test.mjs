// ABI conformance smoke (M0 deliverable 2):
// sm_version / sm_init / the `echo` test op — log effect out, feed back,
// completion via op_status — through the real core.wasm. Plus the import
// section check: the core has no I/O imports, only sm.host.* ports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCore, moduleImports } from "./helpers/load.mjs";

test("sm_version returns the core API semver", async () => {
  const core = await loadCore();
  assert.match(core.sm_version(), /^\d+\.\d+\.\d+$/);
});

test("sm_init accepts an empty config and rejects malformed JSON", async () => {
  const core = await loadCore();
  assert.equal(core.sm_init("{}"), 0);
  assert.equal(core.sm_init("not json"), -1);
  assert.equal(core.sm_init("{\"accounts\": 5}"), -1);
});

test("echo op drives the full effects/feeds loop", async () => {
  const core = await loadCore();
  assert.equal(core.sm_init("{}"), 0);

  const opId = core.op_start("echo", '{"msg":"hello from host"}');
  assert.ok(opId > 0, `expected op id, got ${opId}`);

  const effects = JSON.parse(core.op_effects());
  assert.deepEqual(effects, [
    { kind: "log", level: "info", msg: "hello from host" },
  ]);
  assert.deepEqual(JSON.parse(core.op_effects()), [], "queue drains once");

  let status = JSON.parse(core.op_status(opId));
  assert.equal(status.state, "pending");
  assert.equal(status.result, null);
  assert.equal(status.error, null);

  assert.equal(core.op_feed("echo.data", JSON.stringify({ id: opId, echo: "pong" })), 0);

  status = JSON.parse(core.op_status(opId));
  assert.equal(status.state, "done");
  assert.deepEqual(status.result, { echo: "pong", msg: "hello from host" });
  assert.equal(status.error, null);
});

test("echo op ignores unrelated feeds and keeps waiting", async () => {
  const core = await loadCore();
  core.sm_init("{}");
  const opId = core.op_start("echo", "{}");
  assert.equal(core.op_feed("echo.dataX", JSON.stringify({ id: opId, echo: "nope" })), 0);
  assert.equal(JSON.parse(core.op_status(opId)).state, "pending");
  assert.equal(core.op_feed("echo.data", JSON.stringify({ id: opId, echo: "yes" })), 0);
  assert.equal(JSON.parse(core.op_status(opId)).state, "done");
});

test("op_start rejects bad input with stable codes", async () => {
  const core = await loadCore();
  core.sm_init("{}");
  assert.equal(core.op_start("", "{}"), -1, "empty kind");
  assert.equal(core.op_start("echo", "{oops"), -1, "malformed args");
  assert.equal(core.op_start("no.such.kind", "{}"), -6, "unsupported kind");
});

test("ops require sm_init first (state error)", async () => {
  const core = await loadCore();
  assert.equal(core.op_start("echo", "{}"), -3);
});

test("op_status of an unknown op reports not-found", async () => {
  const core = await loadCore();
  core.sm_init("{}");
  const status = JSON.parse(core.op_status(4242));
  assert.equal(status.state, "error");
  assert.equal(status.error.code, -2);
  assert.equal(status.error.name, "not-found");
});

test("op_cancel cancels a pending op and stale feeds are discarded", async () => {
  const core = await loadCore();
  core.sm_init("{}");
  const opId = core.op_start("echo", "{}");
  assert.equal(core.op_cancel(opId), 0);
  const status = JSON.parse(core.op_status(opId));
  assert.equal(status.state, "cancelled");
  assert.equal(status.error.code, -7);
  assert.equal(core.op_feed("echo.data", JSON.stringify({ id: opId, echo: "late" })), 0);
  assert.equal(JSON.parse(core.op_status(opId)).state, "cancelled");
  assert.equal(core.op_cancel(opId), -3, "cannot cancel a finished op");
  assert.equal(core.op_cancel(999), -2);
});

test("feeds with invalid JSON or unknown targets are handled safely", async () => {
  const core = await loadCore();
  core.sm_init("{}");
  assert.equal(core.op_feed("echo.data", "not json"), -1);
  assert.equal(core.op_feed("echo.data", '{"id":777}'), 0, "stale feed acknowledged");
});

test("core.wasm imports only sm.host ports (plus the AS abort hook)", async () => {
  const imports = await moduleImports("core.wasm");
  const allowed = new Set([
    "sm.host:now_ms",
    "sm.host:random_bytes",
    "sm.host:decode_text",
    "env:abort",
  ]);
  for (const imp of imports) {
    assert.ok(allowed.has(`${imp.module}:${imp.name}`), `forbidden import ${imp.module}:${imp.name}`);
  }
});

test("probes.wasm imports all three sm.host ports and nothing else", async () => {
  const imports = await moduleImports("probes.wasm");
  for (const imp of imports) {
    assert.ok(
      imp.module === "sm.host" || (imp.module === "env" && imp.name === "abort"),
      `forbidden import ${imp.module}:${imp.name}`,
    );
  }
  const hostImports = imports.filter((i) => i.module === "sm.host").map((i) => i.name).sort();
  assert.deepEqual(hostImports, ["decode_text", "now_ms", "random_bytes"]);
});
