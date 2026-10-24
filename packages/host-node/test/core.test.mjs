// Reactor driver (MailCore) through the real core.wasm: the M0 loop plus
// lifecycle edges — timeout cancellation, re-init, account registry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailCore } from "../src/index.ts";

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), "sure-mail-host-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

async function load(t) {
  const logs = [];
  const home = tempHome(t);
  const core = await MailCore.load({
    dataDir: home,
    log: (level, msg) => logs.push({ level, msg }),
  });
  return { core, logs, home };
}

test("version and init through the host driver", async (t) => {
  const { core } = await load(t);
  assert.match(core.version(), /^\d+\.\d+\.\d+$/);
  assert.equal(core.init({}), 0);
  core.close();
});

test("drive runs an op to completion: effects execute, feeds complete", async (t) => {
  const { core, logs } = await load(t);
  core.init({});
  const opId = core.startOp("echo", { msg: "through the reactor" });
  // Feed the completion asynchronously, like a port would.
  setTimeout(() => core.feedExternal("echo.data", { id: opId, echo: "done" }), 10);
  const status = await core.drive(opId, { timeoutMs: 2000 });
  assert.equal(status.state, "done");
  assert.deepEqual(status.result, { echo: "done", msg: "through the reactor" });
  assert.deepEqual(logs, [{ level: "info", msg: "through the reactor" }], "log effect executed");
  core.close();
});

test("drive cancels a stalled op at the deadline", async (t) => {
  const { core } = await load(t);
  core.init({});
  const opId = core.startOp("echo", {});
  const status = await core.drive(opId, { timeoutMs: 50 });
  assert.equal(status.state, "cancelled");
  assert.equal(status.error?.code, -7);
  core.close();
});

test("drive returns immediately when the op is already done", async (t) => {
  const { core } = await load(t);
  core.init({});
  const opId = core.startOp("echo", {});
  core.feedExternal("echo.data", { id: opId, echo: "instant" });
  const status = await core.drive(opId, { timeoutMs: 1000 });
  assert.equal(status.state, "done");
  core.close();
});

test("account registry round-trips through sm_init seeding", async (t) => {
  const { core } = await load(t);
  core.init({});
  assert.equal(
    core.accountAdd({ address: "a@example.com", host: "imap.example.com", port: 993, tls: true }),
    1,
  );
  assert.deepEqual(core.accountList(), [
    { id: 1, address: "a@example.com", host: "imap.example.com", port: 993, tls: true },
  ]);
  // Re-init with rows (the CLI boot pattern) keeps ids monotonic.
  core.init({ accounts: [{ id: 4, address: "b@example.com", host: "imap2.example.com" }] });
  assert.equal(core.accountAdd({ address: "c@example.com", host: "h" }), 5);
  core.close();
});

test("default log sink skips debug noise", async (t) => {
  // MailCore with no log option must not throw when effects log.
  const core = await MailCore.load({ dataDir: tempHome(t) });
  core.init({});
  const opId = core.startOp("echo", { msg: "to stderr" });
  core.feedExternal("echo.data", { id: opId, echo: "ok" });
  const status = await core.drive(opId, { timeoutMs: 1000 });
  assert.equal(status.state, "done");
  core.close();
});
