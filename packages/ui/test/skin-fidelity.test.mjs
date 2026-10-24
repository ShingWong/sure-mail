// M5 measured skin fidelity: the doc's fidelity table, asserted against
// computed styles in a live Chrome — not eyeballed. One boot of the real app
// against the fixture mailbox, then a subtest per skin measuring its
// landmarks (typography, accent, row geometry, structural chrome).
//
//   SURE_MAIL_SKIN_FIDELITY=1 node --test test/skin-fidelity.test.mjs
//
// Env-gated so `npm test` stays offline by default; requires dist-web/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bootFixtureApp, selectSkin } from "./app-harness.mjs";

const enabled = process.env.SURE_MAIL_SKIN_FIDELITY === "1";

test("measured skin fidelity: four skins × the doc's landmarks", { skip: !enabled, timeout: 240000 }, async (t) => {
  const { page, errors } = await bootFixtureApp(t);

  // Measure with a message open so the reading-pane chrome is laid out.
  await page.evaluate(() => window.sureMail.openMessage(0));
  await page.waitForFunction(() => document.querySelector(".sure-mail-thread__title") !== null);

  const probe = async (skin) => {
    await selectSkin(page, skin);
    return page.evaluate(() => {
      const css = (sel, prop) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el)[prop] : `MISSING ${sel}`;
      };
      const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      const rect = (sel) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
      const row = document.querySelector(".sure-mail-row");
      const list = document.querySelector(".sure-mail-list");
      const tab = document.querySelector(".sure-mail-app__tab.is-active");
      const line = document.querySelector(".sure-mail-app__tab.is-active .sure-mail-app__tab-line");
      const bar = rect(".sure-mail-app__read-toolbar");
      const head = rect(".sure-mail-thread__header");
      // Shell rules: the Mac sidebar's solid fallback must live outside
      // @supports, with the blur upgrade inside it.
      const shell = { fallbackOutsideSupports: false, supportsBlursSidebar: false };
      for (const sheet of document.styleSheets) {
        let rules;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        for (const rule of rules) {
          if (rule.selectorText === ".sure-mail-app__rail" && (rule.style?.background ?? "").includes("mail-sidebar-fallback")) {
            shell.fallbackOutsideSupports = true;
          }
          if (rule.conditionText && rule.cssRules) {
            for (const inner of rule.cssRules) {
              if ((inner.selectorText ?? "").includes(".sure-mail-app__rail") && (inner.cssText ?? "").includes("backdrop-filter")) {
                shell.supportsBlursSidebar = true;
              }
            }
          }
        }
      }
      return {
        font: css(".sure-mail-app", "fontFamily"),
        accent: token("--accent"),
        rowH: row ? Math.round(row.getBoundingClientRect().height) : "no row",
        listLines: list ? getComputedStyle(list).getPropertyValue("--mail-list-lines").trim() : "no list",
        railItemRadius: css(".sure-mail-tree__item", "borderRadius"),
        listRadius: css(".sure-mail-app__list", "borderRadius"),
        listShadow: css(".sure-mail-app__list", "boxShadow"),
        rowActions: css(".sure-mail-row .sure-mail-row__actions", "display"),
        stackedClass: list?.classList.contains("sure-mail-list--stacked") ?? false,
        tabBarDisplay: css(".sure-mail-app__tabbar", "display"),
        tabLabelSize: css(".sure-mail-app__tab.is-active .sure-mail-app__tab-label", "fontSize"),
        tabLine: line && tab ? { h: getComputedStyle(line).height, top: Math.round(line.getBoundingClientRect().top - tab.getBoundingClientRect().top) } : null,
        tabbarBottom: rect(".sure-mail-app__tabbar")?.bottom ?? null,
        toolbarTop: rect(".sure-mail-app__top")?.top ?? null,
        toolbarActionW: rect(".sure-mail-app__actions .sure-mail-action")?.width ?? "no action",
        toolbarIconW: rect(".sure-mail-app__actions .sure-mail-action svg")?.width ?? "no icon",
        searchRadius: css(".sure-mail-search__input", "borderRadius"),
        statusMinH: css(".sure-mail-app__status", "minHeight"),
        dotBg: css(".sure-mail-row--unread .sure-mail-app__unread-dot", "backgroundColor"),
        draftIcon: css('.sure-mail-tree__item[data-folder="draft"] .sure-mail-tree__icon', "color"),
        focusTabUnderline: css(".sure-mail-app__list-tabs .sure-mail-search__chip.is-active", "borderBottomColor"),
        toolbarAboveHeader: bar && head ? bar.bottom <= head.top + 1 : "missing",
        railBackdrop: css(".sure-mail-app__rail", "backdropFilter"),
        railBg: css(".sure-mail-app__rail", "backgroundColor"),
        topMinH: css(".sure-mail-app__top", "minHeight"),
        chromeSeparator: token("--chrome-content-separator-color"),
        shell,
      };
    });
  };

  const hoverRowActions = async () => {
    await page.hover(".sure-mail-row");
    const shown = await page.evaluate(() => getComputedStyle(document.querySelector(".sure-mail-row .sure-mail-row__actions")).display);
    await page.mouse.move(1000, 880);
    return shown;
  };

  await t.test("gmail: Roboto, #1a73e8, 40px rows, pill rail, rounded list card, hover actions", async () => {
    const p = await probe("gmail");
    assert.ok(p.font.startsWith("Roboto,"), `Roboto-first stack: ${p.font}`);
    assert.equal(p.accent, "#1a73e8");
    assert.equal(p.rowH, 40, "dense 40px rows");
    assert.equal(p.railItemRadius, "999px", "pill nav rail");
    assert.equal(p.listRadius, "8px", "rounded list card");
    assert.notEqual(p.listShadow, "none", "list card carries a shadow");
    assert.equal(p.rowActions, "none", "row actions hidden at rest");
    assert.equal(await hoverRowActions(), "flex", "row actions revealed on hover");
  });

  await t.test("outlook: Segoe UI, #0078d4, Fluent radius, focused inbox, header card", async () => {
    const p = await probe("outlook");
    assert.ok(p.font.replaceAll('"', "").startsWith("Segoe UI,"), `Segoe UI-first stack: ${p.font}`);
    assert.equal(p.accent, "#0078d4");
    assert.equal(p.listLines, "2", "two-line rows");
    assert.equal(p.stackedClass, true, "stacked modifier applied");
    assert.equal(p.rowH, 56, "two-line rows 56px");
    assert.equal(p.listRadius, "8px", "Fluent card radius");
    assert.equal(p.focusTabUnderline, "rgb(0, 120, 212)", "Focused pivot underlined in accent");
    assert.equal(p.toolbarAboveHeader, true, "message header card under the icon toolbar");
  });

  await t.test("macmail: SF Pro/system, #0a84ff, slim rows, vibrancy, top toolbar", async () => {
    const p = await probe("macmail");
    assert.ok(p.font.replaceAll('"', "").startsWith("-apple-system, BlinkMacSystemFont,"), `system-first stack: ${p.font}`);
    assert.equal(p.accent, "#0a84ff");
    assert.equal(p.rowH, 44, "slim 44px rows");
    assert.equal(p.shell.fallbackOutsideSupports, true, "solid sidebar fallback wired outside @supports");
    assert.equal(p.shell.supportsBlursSidebar, true, "@supports upgrades the sidebar to blur");
    assert.equal(p.topMinH, "44px", "top window toolbar");
  });

  await t.test("thunderbird: system UI, #1373d9, green unread, tab bar, toolbar strip, status footer", async () => {
    const p = await probe("thunderbird");
    assert.ok(p.font.replaceAll('"', "").startsWith("system-ui,"), `system UI stack: ${p.font}`);
    assert.equal(p.accent, "#1373d9", "chrome accent is Bolt blue, not purple");
    assert.equal(p.dotBg, "rgb(22, 163, 74)", "unread dot is green #16a34a");
    assert.equal(p.rowH, 46, "46px card rows");
    assert.equal(p.searchRadius, "3px", "3px rect search field");
    assert.equal(p.draftIcon, "rgb(174, 85, 247)", "Drafts icon purple #ae55f7");
    assert.equal(p.tabBarDisplay, "flex", "tab bar above the panes");
    assert.equal(p.tabLabelSize, "16px", "16px tab labels");
    assert.deepEqual(p.tabLine, { h: "2px", top: 3 }, "2px accent tab line, 3px below the tab top");
    assert.ok(p.toolbarTop >= p.tabbarBottom - 0.5, "unified toolbar sits under the tab bar");
    assert.equal(p.toolbarActionW, 32, "32px toolbar buttons");
    assert.equal(p.toolbarIconW, 16, "16px toolbar glyphs");
    assert.equal(p.statusMinH, "22px", "status footer");
  });

  await t.test("dark variants: every skin repaints its canvas", async () => {
    for (const skin of ["gmail", "outlook", "macmail", "thunderbird"]) {
      await selectSkin(page, skin);
      const light = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
      await page.click('button[title="Settings"]');
      await page.selectOption('select[aria-label="Theme"]', "dark");
      await page.click('.sure-mail-app__settings .btn-secondary');
      await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
      const dark = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
      assert.notEqual(dark, light, `${skin}: dark variant repaints --bg (${light} -> ${dark})`);
      await page.click('button[title="Settings"]');
      await page.selectOption('select[aria-label="Theme"]', "light");
      await page.click('.sure-mail-app__settings .btn-secondary');
      await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    }
  });

  assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
});
