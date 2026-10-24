// M5 visual QA harness. Boots the real app against the real core + relay +
// fixture mailbox (MockIMAP), then screenshots every skin × {list, thread,
// compose} × {desktop, mobile} and diffs each shot against the committed
// baseline in test/baselines/. The diff is measured in the browser (canvas
// pixel compare), so the harness needs no image dependency.
//
//   SURE_MAIL_VISUAL=1 node --test test/visual-qa.test.mjs
//   SURE_MAIL_VISUAL=1 SURE_MAIL_VISUAL_UPDATE=1 node --test test/visual-qa.test.mjs   # re-baseline
//
// Env-gated so `npm test` stays offline by default; requires dist-web/.
// Reference renders to cross-check against live in sure-ui's
// docs/fidelity/*.png (Gmail / Outlook / Mac Mail / Thunderbird).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootFixtureApp, selectSkin, VIEWPORTS } from "./app-harness.mjs";

const enabled = process.env.SURE_MAIL_VISUAL === "1";
const update = process.env.SURE_MAIL_VISUAL_UPDATE === "1";
const here = dirname(fileURLToPath(import.meta.url));
const BASELINES = join(here, "baselines");

const SKIN_IDS = ["gmail", "outlook", "macmail", "thunderbird"];
const VIEWS = ["list", "thread", "compose"];
/** Allowed per-pixel difference before a render counts as changed. */
const MAX_DIFF_RATIO = 0.005;

test("visual QA: four skins × three views × two viewports", { skip: !enabled, timeout: 300000 }, async (t) => {
  mkdirSync(BASELINES, { recursive: true });
  const { browser, page, errors } = await bootFixtureApp(t);
  // A second context: screenshotting the app page while another page in the
  // same context is open intermittently stalls the capture.
  const diffContext = await browser.newContext();
  const diffPage = await diffContext.newPage();
  await diffPage.goto("about:blank");
  t.after(() => diffContext.close());

  const results = [];
  for (const [viewport, size] of Object.entries(VIEWPORTS)) {
    await page.setViewportSize(size);
    for (const skin of SKIN_IDS) {
      await selectSkin(page, skin);
      for (const view of VIEWS) {
        if (view === "compose") {
          await page.locator('button[title="Compose (c)"]:visible').first().click();
          await page.waitForFunction(() => document.querySelector(".sure-mail-app__compose")?.hidden === false);
        } else if (view === "list") {
          await page.keyboard.press("Escape"); // close compose if open
          // List view: no message open — the reading pane shows its empty state.
          await page.evaluate(() => window.sureMail.openMessage(-1));
          await page.waitForFunction(() => document.querySelector(".sure-mail-thread") === null);
        } else {
          // Thread view: the first message open in the reading pane.
          await page.evaluate(() => window.sureMail.openMessage(0));
          await page.waitForFunction(() => document.querySelector(".sure-mail-thread__title") !== null);
        }
        const name = `${skin}-${view}-${viewport}.png`;
        const current = await page.screenshot({ type: "png" });
        const file = join(BASELINES, name);
        if (update || !existsSync(file)) {
          writeFileSync(file, current);
          results.push({ name, ratio: 0, state: update ? "written" : "created" });
        } else {
          const baseline = readFileSync(file);
          const ratio = await diffRatio(diffPage, baseline, current);
          results.push({ name, ratio, state: ratio > MAX_DIFF_RATIO ? "CHANGED" : "ok" });
        }
      }
      await page.keyboard.press("Escape");
    }
  }

  for (const result of results) {
    const detail =
      result.state === "CHANGED"
        ? `${result.state} (${(result.ratio * 100).toFixed(2)}% > ${(MAX_DIFF_RATIO * 100).toFixed(2)}%)`
        : result.state;
    console.log(`VISUAL ${result.name.padEnd(34)} ${detail}`);
  }
  const changed = results.filter((r) => r.state === "CHANGED");
  assert.deepEqual(changed.map((r) => r.name), [], "renders drifted from the committed baselines");
  assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
});

/** Pixel diff two PNGs inside the browser (canvas; no image dependency). */
async function diffRatio(diffPage, baseline, current) {
  return diffPage.evaluate(
    async ([a, b]) => {
      const load = (src) =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error("could not decode screenshot"));
          img.src = src;
        });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      if (ia.width !== ib.width || ia.height !== ib.height) return 1;
      const canvas = document.createElement("canvas");
      canvas.width = ia.width;
      canvas.height = ia.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(ia, 0, 0);
      const da = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(ib, 0, 0);
      const db = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let diff = 0;
      for (let i = 0; i < da.length; i += 4) {
        if (
          Math.abs(da[i] - db[i]) > 8 ||
          Math.abs(da[i + 1] - db[i + 1]) > 8 ||
          Math.abs(da[i + 2] - db[i + 2]) > 8
        ) {
          diff++;
        }
      }
      return diff / (canvas.width * canvas.height);
    },
    [`data:image/png;base64,${baseline.toString("base64")}`, `data:image/png;base64,${current.toString("base64")}`],
  );
}
