// Shared browser harness for the M5 env-gated suites (visual QA, measured
// skin fidelity, runtime switch): starts the real relay + fixture MockIMAP +
// MockSMTP + the app server, boots the app in Chrome and syncs the fixture
// mailbox once. Both suites then drive the live app.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startRelay } from "../../host-node/src/index.ts";
import { MockIMAP } from "../../host-node/test/mock-imap.mjs";
import { MockSMTP } from "../../host-node/test/mock-smtp.mjs";
import { startAppServer } from "../scripts/serve.mjs";
import { armFixture, FIXTURE_MESSAGES } from "./fixture-mailbox.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const DIST = join(here, "..", "dist-web");

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

/** Boot the app against the fixture mailbox. Requires dist-web/. */
export async function bootFixtureApp(t, { viewport = VIEWPORTS.desktop, theme = "light" } = {}) {
  if (!existsSync(join(DIST, "app.js"))) throw new Error("run npm run build:web first (dist-web/app.js missing)");
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
    headless: process.env.SURE_MAIL_HEADED !== "1",
    args: ["--enable-features=SharedArrayBuffer", "--allow-file-access-from-files"],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport });
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
    theme,
  });
  await page.goto(`${server.url}?${params}`, { waitUntil: "load" });
  await page.waitForFunction(() => document.documentElement.dataset.booted === "true", { timeout: 60000 });
  await page.fill("#account-password", "hunter2");
  await page.click('form[aria-label="Add an account"] button[type="submit"]');
  await page.waitForFunction(() => window.sureMail?.accounts.length === 1, { timeout: 30000 });

  // One real sync populates the local store; later renders read it back.
  armFixture(mock);
  await page.click('button[title="Sync (r)"]');
  await page.waitForFunction(() => window.sureMail.folder === "INBOX", { timeout: 30000 });
  await page.waitForFunction((n) => window.sureMail.messageList.length === n, FIXTURE_MESSAGES.length, { timeout: 30000 });
  await page.waitForFunction((n) => document.querySelectorAll(".sure-mail-row").length === n, FIXTURE_MESSAGES.length, {
    timeout: 30000,
  });
  return { browser, context, page, errors, mock, smtp, relay, server };
}

/** Switch skin through the real settings dialog (the M5 runtime path). */
export async function selectSkin(page, id) {
  await page.click('button[title="Settings"]');
  await page.selectOption('select[aria-label="Skin"]', id);
  await page.click('.sure-mail-app__settings .btn-secondary');
  await page.waitForFunction((skin) => document.getElementById("sure-mail-skin")?.dataset.skin === skin, id, {
    timeout: 10000,
  });
}
