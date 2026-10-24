// M4 browser acceptance: the real app (packages/ui) in headless Chromium
// against REAL core.wasm + REAL relay + MockIMAP + MockSMTP + the OPFS store
// worker. Covers: add account -> sync -> list -> read -> search -> compose
// (save draft + send, filed to Sent and audited) -> skin hot-swap (no reload,
// component CSS untouched) -> OPFS persistence across reload -> console-error
// clean.
//
// Env-gated so `npm test` stays offline by default:
//
//   SURE_MAIL_BROWSER_E2E=1 node --test test/browser-app.test.mjs
//
// Requires dist-web/ (npm run build:web).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startRelay } from "../../host-node/src/index.ts";
import { MockIMAP, loginScripts, envelopeLine } from "../../host-node/test/mock-imap.mjs";
import { MockSMTP } from "../../host-node/test/mock-smtp.mjs";
import { startAppServer } from "../scripts/serve.mjs";

const enabled = process.env.SURE_MAIL_BROWSER_E2E === "1";
const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist-web");

const RAW_MSG = [
  "From: Alice <alice@example.com>",
  "To: me@example.com",
  "Subject: First message",
  "Date: Thu, 16 Oct 2026 12:00:00 +0000",
  "Message-ID: <m1@example.com>",
  "",
  "Hello from the browser host",
  "",
].join("\r\n");

/**
 * Arm one imap.folders connection: login + LIST. The app lists folders when an
 * account is activated (add + every reload), independently of any sync, so the
 * rail is complete before a walk has reached every folder.
 */
function armFolders(mock, folders = ["INBOX"]) {
  loginScripts(mock);
  mock.script(
    /LIST "" "\*"/,
    [...folders.map((f) => `* LIST (\\HasNoChildren) "/" "${f}"`), `{tag} OK LIST done`].join("\r\n") + "\r\n",
  );
}

/** Arm one full no-folder imap.sync: LIST -> SELECT -> meta -> bodies. */
function armFullSync(mock) {
  loginScripts(mock);
  mock.script(
    /LIST "" "\*"/,
    [`* LIST (\\HasNoChildren) "/" "INBOX"`, `{tag} OK LIST done`].join("\r\n") + "\r\n",
  );
  mock.script(
    /SELECT "INBOX"/,
    [
      "* 1 EXISTS",
      "* 0 RECENT",
      "* OK [UIDVALIDITY 100] UIDs valid",
      "{tag} OK [READ-WRITE] SELECT done",
    ].join("\r\n") + "\r\n",
  );
  mock.script(/UID FETCH 1:\* \(UID FLAGS INTERNALDATE RFC822\.SIZE ENVELOPE\)/, (line) => {
    const tag = line.split(" ")[0];
    return (
      envelopeLine(1, 1, "First message", "alice", "me@example.com", "16-Oct-2026 12:00:00 +0000") +
      `\r\n${tag} OK UID FETCH done\r\n`
    );
  });
  mock.script(/UID FETCH 1 \(UID FLAGS INTERNALDATE BODY\.PEEK\[\]\)/, (line) => {
    const tag = line.split(" ")[0];
    const bytes = Buffer.byteLength(RAW_MSG, "latin1");
    return (
      `* 1 FETCH (UID 1 FLAGS (\\Seen) INTERNALDATE "16-Oct-2026 12:00:00 +0000" BODY[] {${bytes}}\r\n` +
      `${RAW_MSG}\r\n${tag} OK bodies done\r\n`
    );
  });
}

/**
 * Arm the two IMAP connections the shared send flow opens after the send:
 * imap.folders (LIST, exposing \Sent) then imap.append (the filed copy).
 */
function armSendScripts(mock) {
  loginScripts(mock);
  mock.script(
    /LIST "" "\*"/,
    [
      `* LIST (\\HasNoChildren) "/" "INBOX"`,
      `* LIST (\\HasNoChildren \\Sent) "/" "Sent"`,
      `{tag} OK LIST done`,
    ].join("\r\n") + "\r\n",
  );
  loginScripts(mock);
  mock.script(/APPEND "Sent"/, "{tag} OK [APPENDUID 900 77] done\r\n");
}

test("app e2e: account -> sync -> list/read/search -> compose -> skins -> reload", { skip: !enabled, timeout: 180000 }, async (t) => {
  assert.ok(existsSync(join(DIST, "app.js")), "run npm run build:web first (dist-web/app.js missing)");

  const mock = new MockIMAP();
  const smtp = new MockSMTP();
  smtp.scriptSuccess();
  const imapPort = await mock.listen();
  const smtpPort = await smtp.listen();
  const relay = await startRelay({ port: 0 });
  const server = await startAppServer({ port: 0, outDir: DIST });
  t.after(async () => {
    await mock.close();
    await smtp.close();
    relay.close();
    await server.close();
  });

  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({
    executablePath: process.env.SURE_MAIL_CHROME ?? "/usr/bin/google-chrome",
    // Headful is a debugging aid (SURE_MAIL_HEADED=1 with DISPLAY set); CI and
    // the default run are headless.
    headless: process.env.SURE_MAIL_HEADED !== "1",
    args: ["--enable-features=SharedArrayBuffer", "--allow-file-access-from-files"],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });

  const params = new URLSearchParams({
    relay: `ws://127.0.0.1:${relay.port}`,
    address: "me@example.com",
    host: "127.0.0.1",
    port: String(imapPort),
    tls: "0",
    user: "me@example.com",
    smtp_host: "127.0.0.1",
    smtp_port: String(smtpPort),
  });
  await page.goto(`${server.url}?${params}`, { waitUntil: "load" });
  // Report the page's own errors when boot fails: without this the failure is
  // just an opaque "Timeout exceeded".
  try {
    // 60s, not 30s: the test's own timeout is 180s, and a boot that races a
    // busy machine (fresh npm install, rebuilds, indexing) is not a failure.
    await page.waitForFunction(() => document.documentElement.dataset.booted === "true", { timeout: 60000 });
  } catch (err) {
    const dump = await page
      .evaluate(() => ({
        booted: document.documentElement.dataset.booted,
        appChildren: document.getElementById("app")?.childElementCount ?? 0,
        text: (document.body.innerText || "").slice(0, 200),
      }))
      .catch(() => null);
    throw new Error(
      `app did not boot: ${err instanceof Error ? err.message : String(err)}; ` +
        `page errors: ${errors.join(" | ") || "(none)"}; dom: ${JSON.stringify(dump)}`,
    );
  }

  const persistent = await page.evaluate(() => window.sureMail.host.storeClient.ready());
  assert.equal(persistent, true, "store must be OPFS-persistent in the browser");
  assert.equal(await page.evaluate(() => window.sureMail.host.net.connected), true, "relay connected");

  // 1. first-run: add the account (prefilled except password). Adding it
  // activates it, and activation lists folders before anything is synced.
  armFolders(mock);
  await page.fill("#account-password", "hunter2");
  await page.click('form[aria-label="Add an account"] button[type="submit"]');
  await page.waitForFunction(() => window.sureMail?.accounts.length === 1, { timeout: 30000 });

  // 2. sync the account (no folder selected -> imap.sync lists + syncs all).
  armFullSync(mock);
  await page.click('button[title="Sync (r)"]');
  await page.waitForFunction(() => window.sureMail.folder === "INBOX", { timeout: 30000 });
  await page.waitForFunction(() => window.sureMail.messageList.length === 1, { timeout: 30000 });

  // 3. list + read.
  const rows = await page.locator(".sure-mail-row").count();
  assert.equal(rows, 1, "one message row");
  await page.waitForFunction(() => window.sureMail.reading?.subject === "First message", { timeout: 30000 });
  assert.match(await page.textContent(".sure-mail-thread__body"), /Hello from the browser host/);
  assert.match(await page.textContent(".sure-mail-thread__title"), /First message/);

  // 4. search (local FTS5).
  await page.fill(".sure-mail-search__input", "Hello");
  await page.press(".sure-mail-search__input", "Enter");
  await page.waitForFunction(() => window.sureMail.searching && window.sureMail.messageList.length === 1, { timeout: 30000 });
  assert.match(await page.textContent(".sure-mail-row__subject"), /First message/);

  // 5. compose: save a draft, then send through MockSMTP.
  await page.locator('button[title="Compose (c)"]:visible').first().click();
  await page.fill("#compose-to", "bob@example.com");
  await page.fill("#compose-subject", "Greetings");
  await page.fill("#compose-body", "Body of the outbound message.");
  await page.click('.sure-mail-compose__actions .btn-secondary:has-text("Save draft")');
  await page.waitForFunction(() => document.querySelector(".sure-mail-compose__status")?.textContent?.startsWith("Draft "), { timeout: 30000 });
  // the shared send flow opens two more IMAP connections (folders, append)
  armSendScripts(mock);
  await page.click('.sure-mail-compose__actions .btn-primary:has-text("Send")');
  await page.waitForFunction(() => document.querySelector(".sure-mail-app__compose")?.hidden === true, { timeout: 60000 });
  assert.equal(smtp.messages.length, 1, "SMTP DATA payload reached MockSMTP");
  assert.match(smtp.messages[0], /Subject: Greetings/);
  assert.ok(
    mock.received.some((line) => /APPEND "Sent"/.test(line)),
    "the browser filed the sent copy to Sent",
  );

  // The browser host runs the same flow as the CLI (D15), so the send is
  // audited locally: read the row back through the page's own host.
  const audit = await page.evaluate(async () => {
    const app = window.sureMail;
    const account = Number(app.accounts[0].id);
    const opId = app.host.startOp("store.query", {
      store: `account:${account}`,
      query: "sent_messages",
      args: { account, limit: 5 },
    });
    const status = await app.host.drive(opId, { timeoutMs: 15000 });
    return status.result?.rows ?? [];
  });
  assert.equal(audit.length, 1, "the browser wrote the sent_messages audit row");
  assert.equal(audit[0].appended, 1, "audit records the Sent append");
  assert.equal(audit[0].sent_folder, "Sent");
  assert.equal(audit[0].subject, "Greetings");

  // 6. runtime skin + theme switch from the settings dialog: no reload,
  // component CSS untouched, overlay swapped, chrome + theme attribute flipped.
  const before = await page.evaluate(() => ({
    base: document.getElementById("sure-mail-base").textContent,
    overlay: document.getElementById("sure-mail-skin").textContent,
    font: getComputedStyle(document.documentElement).getPropertyValue("--font-body").trim(),
    stacked: document.querySelector(".sure-mail-list")?.classList.contains("sure-mail-list--stacked"),
    skin: document.getElementById("app").dataset.skin,
    theme: document.documentElement.dataset.theme,
    tabbar: getComputedStyle(document.querySelector(".sure-mail-app__tabbar")).display,
    readToolbar: !!document.querySelector(".sure-mail-app__read-toolbar .sure-mail-action"),
    status: !!document.querySelector(".sure-mail-app__status"),
    marker: (window.__marker = "kept"),
  }));
  await page.click('button[title="Settings"]');
  await page.selectOption('select[aria-label="Skin"]', "outlook");
  await page.selectOption('select[aria-label="Theme"]', "dark");
  await page.click('.sure-mail-app__settings .btn-secondary');
  await page.waitForFunction(() => window.sureMail.skinId === "outlook", { timeout: 10000 });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark", { timeout: 10000 });
  const after = await page.evaluate(() => ({
    base: document.getElementById("sure-mail-base").textContent,
    overlay: document.getElementById("sure-mail-skin").textContent,
    font: getComputedStyle(document.documentElement).getPropertyValue("--font-body").trim(),
    stacked: document.querySelector(".sure-mail-list")?.classList.contains("sure-mail-list--stacked"),
    skin: document.getElementById("app").dataset.skin,
    theme: document.documentElement.dataset.theme,
    tabbar: getComputedStyle(document.querySelector(".sure-mail-app__tabbar")).display,
    readToolbar: !!document.querySelector(".sure-mail-app__read-toolbar .sure-mail-action"),
    status: !!document.querySelector(".sure-mail-app__status"),
    marker: window.__marker,
  }));
  assert.equal(after.marker, "kept", "no page reload during a skin swap");
  assert.notEqual(after.overlay, before.overlay, "the skin overlay changed");
  assert.equal(after.base, before.base, "the layered component CSS is untouched by a skin swap");
  assert.match(after.font, /Segoe UI/, "Outlook typography applied");
  assert.equal(after.stacked, true, "Outlook switches the list to two-line rows");
  assert.equal(after.skin, "outlook", "the shell root carries the active skin id");
  assert.equal(after.theme, "dark", "the settings theme switch sets the dark attribute");
  assert.equal(before.theme, "light", "the boot theme defaults to light");
  assert.equal(before.tabbar, "none", "Gmail hides the spaces tab bar");
  assert.equal(before.readToolbar, true, "the reading-pane toolbar exists");
  assert.equal(before.status, true, "the status footer exists");

  // 7. OPFS persistence: reload and the account + message survive. Activation
  // lists folders again, so that connection needs a script too.
  armFolders(mock);
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => document.documentElement.dataset.booted === "true", { timeout: 30000 });
  await page.waitForFunction(() => window.sureMail.accounts.length === 1, { timeout: 30000 });
  assert.equal(await page.textContent(".sure-mail-app__account-name"), "me@example.com");
  await page.waitForFunction(() => window.sureMail.messageList.length === 1, { timeout: 30000 });

  assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
});
