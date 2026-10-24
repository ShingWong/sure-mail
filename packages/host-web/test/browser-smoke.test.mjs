// Browser smoke test: drive the built harness in headless Chromium with
// the system Chrome. Verifies core.wasm instantiates in a real browser,
// the store worker reports OPFS persistence, and the relay/echo path runs.
// Env-gated (needs the serve.mjs harness on 127.0.0.1:8788 + a relay):
//
//   SURE_MAIL_BROWSER_SMOKE=1 node test/browser-smoke.test.mjs
//
// Without the env var this is a no-op skip, so `npm test` stays offline.
import { test } from "node:test";
import assert from "node:assert/strict";

const enabled = process.env.SURE_MAIL_BROWSER_SMOKE === "1";
const HARNESS = process.env.SURE_MAIL_HARNESS_URL ?? "http://127.0.0.1:8788/";

test("browser smoke: core.wasm boots, store is OPFS-persistent, echo op runs", { skip: !enabled }, async () => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({
    executablePath: process.env.SURE_MAIL_CHROME ?? "/usr/bin/google-chrome",
    headless: true,
    args: [
      // OPFS sync access handles need cross-origin isolation; the harness
      // serves COOP/COEP, and these flags let Chrome honor them on loopback.
      "--enable-features=SharedArrayBuffer",
      "--allow-file-access-from-files",
    ],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    const boot = [];
    page.on("console", (msg) => boot.push(msg.text()));

    // main() resolves once the store worker is ready and window.mailHost is
    // fully wired. Awaiting it guarantees every store.exec in runChecks()
    // and the durability check has a live worker — otherwise the first drive
    // races the boot and reports "unknown op id".
    await page.goto(HARNESS, { waitUntil: "load" });
    await page.waitForFunction(() => window.__booted === true, { timeout: 15000 });

    const version = await page.evaluate(() => window.mailHost.version());
    assert.match(version, /^\d+\.\d+\.\d+$/, `core version: ${version}`);

    const persistent = await page.evaluate(() => window.mailHost.storeClient.ready());
    assert.equal(persistent, true, "store must report OPFS persistence in the browser");

    const done = await page.evaluate(() => window.runChecks());
    assert.equal(done, "done");

    // OPFS durability proof: seed an account, reload the page (fresh worker,
    // fresh OPFS mount), then re-seed from the registry store the way the
    // real CLI boot does (cli: core.init({accounts: rows})) and confirm the
    // account survived the reload.
    const id = await page.evaluate(async () => {
      const h = window.mailHost;
      await h.ensureSchema("registry");
      const newId = h.accountAdd({ address: "persist@example.com", host: "h", port: 993, tls: true });
      await h.flush();
      return newId;
    });
    assert.ok(id > 0, `accountAdd should return a positive id, got ${id}`);

    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => window.__booted === true, { timeout: 15000 });
    const after = await page.evaluate(async () => {
      const h = window.mailHost;
      const opId = h.startOp("store.query", { store: "registry", query: "accounts" });
      const st = await h.drive(opId, { timeoutMs: 5000 });
      return { state: st.state, error: st.error, rows: st.result?.rows ?? null, raw: JSON.stringify(st).slice(0, 300) };
    });
    assert.equal(after.state, "done", `store.query failed: ${after.raw}`);
    assert.ok(
      after.rows?.some((a) => a.address === "persist@example.com"),
      `expected persisted account in ${JSON.stringify(after)}`,
    );
    assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
  } finally {
    await browser.close();
  }
});

test("browser smoke: boots read-only with no relay (local store still works)", { skip: !enabled }, async () => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({
    executablePath: process.env.SURE_MAIL_CHROME ?? "/usr/bin/google-chrome",
    headless: true,
    args: ["--enable-features=SharedArrayBuffer", "--allow-file-access-from-files"],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));

    // A port nothing can be listening on: the M4 "no relay" case.
    const dead = new URL(HARNESS);
    dead.search = "";
    dead.searchParams.set("relay", "ws://127.0.0.1:1/");
    await page.goto(dead.toString(), { waitUntil: "load" });
    await page.waitForFunction(() => window.__booted === true, { timeout: 15000 });

    const state = await page.evaluate(async () => {
      const h = window.mailHost;
      const persistent = await h.storeClient.ready();
      await h.ensureSchema("registry");
      const id = h.accountAdd({ address: "readonly@example.com", host: "h", port: 993, tls: true });
      await h.flush();
      return { connected: h.net.connected, persistent, id, accounts: h.accountList().map((a) => a.address) };
    });
    assert.equal(state.connected, false, "no relay is connected");
    assert.equal(state.persistent, true, "OPFS store is still the source of truth");
    assert.ok(state.id > 0);
    assert.ok(state.accounts.includes("readonly@example.com"), JSON.stringify(state));
    assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
  } finally {
    await browser.close();
  }
});
