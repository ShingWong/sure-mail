// Skin engine unit tests — pure string assembly, no DOM, offline. Proves:
//   1. the catalog registers the four Track B skins in D6 order, each folder
//      exporting the full M5 spec (tokens, layout, componentOverrides,
//      dark, mobile);
//   2. every skin composes through sure-ui's layer model and the layered
//      component CSS is byte-identical across the four skins — which is what
//      "swapping a skin never touches component CSS" means;
//   3. the consumer half stays unlayered: no `@layer` in the overlay, no
//      overlay bytes leak into the layered base (stripLayers purity), and the
//      overlay concatenates layout → chrome → tokens → dark → mobile;
//   4. the token blocks declare only `:root` variables, the dark palette is
//      scoped to `[data-theme="dark"]`, and the mobile block is media-scoped;
//   5. the typography contract and the mail density/weight tokens are set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LAYER_DECL, stripLayers } from "@shing.wong/sure-ui/compose";
import {
  SKINS,
  SKIN_IDS,
  SKIN_MODULES,
  DEFAULT_SKIN_ID,
  SHELL_COMPONENTS,
  getSkin,
  composeSkin,
  renderSkin,
  skinOverlay,
} from "../src/skin/index.ts";
import { compose } from "@shing.wong/sure-ui/compose";

const EXPECTED_IDS = ["gmail", "outlook", "macmail", "thunderbird"];

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Selectors declared in a CSS string (top-level blocks only). */
function selectorsOf(css) {
  return stripComments(css)
    .split("}")
    .map((block) => block.split("{")[0].trim())
    .filter((s) => s.length > 0);
}

test("registry: the four Track B skins, in the D6 order", () => {
  assert.deepEqual([...SKIN_IDS], EXPECTED_IDS);
  assert.equal(SKINS.length, 4);
  assert.deepEqual(
    SKIN_MODULES.map((s) => s.id),
    EXPECTED_IDS,
    "skin folders register in build order",
  );
  assert.equal(DEFAULT_SKIN_ID, "gmail");
  for (const skin of SKINS) {
    assert.equal(typeof skin.name, "string");
    assert.ok(skin.components.includes("mail-list"), skin.id);
    assert.equal(skin.theme, "nord");
    assert.deepEqual(skin.components, SHELL_COMPONENTS);
  }
});

test("registry: getSkin resolves by id and rejects unknown ids", () => {
  assert.equal(getSkin("thunderbird").name, "Thunderbird");
  assert.throws(() => getSkin("evolution"), /unknown skin "evolution"/);
});

test("skin folders export the full M5 spec (tokens/layout/chrome/dark/mobile)", () => {
  for (const skin of SKIN_MODULES) {
    for (const field of ["id", "name", "tokens", "layout", "componentOverrides", "dark", "mobile"]) {
      assert.equal(typeof skin[field], "string", `${skin.id}: ${field} must be a string`);
      assert.ok(skin[field].trim().length > 0, `${skin.id}: ${field} must not be empty`);
    }
    assert.equal(typeof skin.stackedList, "boolean", skin.id);
    // The 5-field contract the M5 doc names, plus identity.
    assert.deepEqual(
      Object.keys(skin).sort(),
      ["componentOverrides", "dark", "id", "layout", "mobile", "name", "stackedList", "tokens"].sort(),
      `${skin.id}: skin folder exports exactly the documented spec`,
    );
  }
});

test("compose: base is the sure-ui layer model for every skin", () => {
  for (const skin of SKINS) {
    const { base } = composeSkin(skin);
    assert.ok(base.startsWith(LAYER_DECL), `${skin.id}: layer declaration first`);
    for (const layer of ["sure.tokens", "sure.components", "sure.mobile"]) {
      assert.ok(base.includes(`@layer ${layer} {`), `${skin.id}: missing ${layer}`);
    }
    // Component runs selected by the skin are actually present.
    for (const sel of [".sure-mail-row", ".sure-mail-thread", ".sure-mail-tree",
      ".sure-mail-compose", ".sure-mail-search", ".sure-mail-action", ".btn-primary"]) {
      assert.ok(base.includes(sel), `${skin.id}: base missing ${sel}`);
    }
  }
});

test("compose: the layered component CSS is byte-identical across skins", () => {
  const canonical = compose({ theme: "nord", components: SHELL_COMPONENTS });
  for (const skin of SKINS) {
    assert.equal(composeSkin(skin).base, canonical, `${skin.id}: component CSS must not vary`);
  }
});

test("layers intact: no consumer override leaks into the layered base", () => {
  for (const skin of SKINS) {
    const { base, overlay } = composeSkin(skin);
    // The layered half is exactly sure-ui's compose() output — strip the
    // wrappers and nothing of the skin is left behind.
    assert.equal(stripLayers(base), stripLayers(compose({ theme: skin.theme, components: skin.components })));
    for (const part of [skin.layout, skin.componentOverrides, skin.tokens, skin.dark]) {
      assert.ok(!base.includes(part), `${skin.id}: consumer CSS leaked into the layered base`);
    }
    assert.ok(!base.includes("sure-mail-app__"), `${skin.id}: shell chrome must stay unlayered`);
    assert.ok(!overlay.includes("@layer"), `${skin.id}: overlay must stay unlayered`);
    assert.ok(!base.includes('[data-theme="dark"]'), `${skin.id}: dark palette must stay unlayered`);
  }
});

test("overlay order: layout → chrome → tokens → dark → mobile", () => {
  for (const skin of SKINS) {
    const { overlay } = composeSkin(skin);
    for (const part of [skin.layout, skin.componentOverrides, skin.tokens, skin.dark, skin.mobile]) {
      assert.ok(overlay.includes(part), `${skin.id}: overlay carries every part`);
    }
    const order = [skin.layout, skin.componentOverrides, skin.tokens, skin.dark, skin.mobile].map((p) =>
      overlay.indexOf(p),
    );
    for (let i = 1; i < order.length; i++) {
      assert.ok(order[i] > order[i - 1], `${skin.id}: overlay parts out of order at ${i}`);
    }
    assert.equal(renderSkin(skin), `${composeSkin(skin).base}\n${overlay}`);
    assert.equal(skinOverlay(skin), overlay);
  }
});

test("tokens: light and dark blocks declare only :root variables", () => {
  for (const skin of SKINS) {
    for (const [label, block] of [["light", skin.tokens], ["dark", skin.dark]]) {
      assert.ok(block.includes(":root"), `${skin.id}/${label}: needs a :root block`);
      for (const sel of selectorsOf(block)) {
        assert.ok(sel === ":root" || sel.startsWith(':root[data-theme="'), `${skin.id}/${label}: unexpected selector "${sel}"`);
      }
    }
    // Dark is explicitly scoped so the shell's `auto` can set the attribute.
    assert.ok(skin.dark.includes(':root[data-theme="dark"]'), `${skin.id}: dark must scope to [data-theme="dark"]`);
    // No component selector is skinned by a token block.
    assert.ok(!stripComments(skin.tokens).includes(".sure-mail-"), `${skin.id}: component selector in light tokens`);
    assert.ok(!stripComments(skin.dark).includes(".sure-mail-"), `${skin.id}: component selector in dark tokens`);
  }
});

test("mobile block is media-scoped and unlayered", () => {
  for (const skin of SKINS) {
    assert.match(skin.mobile, /@media[^{]+\{/, `${skin.id}: mobile needs a media query`);
    assert.ok(!skin.mobile.includes("@layer"), `${skin.id}: mobile must stay unlayered`);
    assert.ok(skin.mobile.includes(".sure-mail-app"), `${skin.id}: mobile tunes the shell grid`);
  }
});

test("chrome block targets the shell's own classes, not the theme", () => {
  for (const skin of SKINS) {
    assert.ok(skin.componentOverrides.includes(".sure-mail-app__"), `${skin.id}: chrome styles the shell`);
    assert.ok(!skin.componentOverrides.includes("@layer"), `${skin.id}: chrome must stay unlayered`);
    assert.ok(!skin.componentOverrides.includes("--font-body"), `${skin.id}: chrome must not re-declare the contract`);
  }
});

test("skin: honours the typography contract and the mail semantic tokens", () => {
  for (const skin of SKINS) {
    for (const token of ["--font-body", "--mail-list-row-h", "--mail-selected-bg"]) {
      assert.ok(skin.tokens.includes(token), `${skin.id}: missing ${token}`);
    }
    const { base } = composeSkin(skin);
    for (const token of ["--font-body", "--font-size", "--line-height", "--mail-density",
      "--mail-unread-weight", "--mail-search-radius"]) {
      assert.ok(base.includes(token), `${skin.id}: base must define ${token}`);
    }
  }
});

test("skin: only Outlook opts into the stacked (two-line) list", () => {
  assert.equal(getSkin("outlook").stackedList, true);
  for (const id of ["gmail", "macmail", "thunderbird"]) {
    assert.equal(getSkin(id).stackedList, false, id);
  }
});
