// macOS Mail (Sonoma) — third skin in the D6 build order.
// Tokens ported from sure-ui's measured reference composition
// (experiments/mail-macmail/macmail-skin.css, 43/43 fidelity checks). The
// chrome (unified window toolbar, vibrancy sidebar with a solid fallback,
// flush hairline panes) lands in its own commit on top of this block.
import { MACMAIL_LAYOUT } from "../../layout.ts";
import type { SkinSpec } from "../../types.ts";

const tokens = `
/* macOS Mail (Sonoma) — system-first at 13px, #0a84ff, hairlines, 44px rows,
   vibrancy sidebar with a solid fallback. */
:root {
  --font-body: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --font-size: 81.25%;

  --bg: #f4f4f5;
  --surface: #fff;
  --text: #1c1c1e;
  --muted: #6e6e73;
  --border: #e5e5ea;
  --field: #f2f2f7;
  --highlight: #f2f2f7;
  --accent: #0a84ff;
  --focus: #0a84ff;
  --on-accent: #fff;
  --primary: #0a84ff;
  --primary-hover: #3294ff;
  --primary-ink: #fff;
  --error: #ff5f57;
  --warn: #febc2e;
  --success: #28c840;

  --mail-accent-alias: #0a84ff;
  --mail-accent-ink: #fff;
  --mail-flag-ink: #ff9500;

  --mail-sidebar-fallback: #f2f2f7;
  --mail-sidebar-bg: rgba(246, 246, 246, 0.72);

  --mail-list-bg: #fff;
  --mail-list-border: #e5e5ea;
  --mail-radius: 0px;
  --mail-list-row-bg: #fff;
  --mail-list-row-border: #ececef;
  --mail-list-row-h: calc(44px * var(--mail-density));
  --mail-list-sender-w: 8rem;
  --mail-hover-bg: #f2f2f7;
  --mail-unread-bg: #fff;
  --mail-unread-weight: 700;
  --mail-selected-bg: #d6e7fb;

  --mail-tree-item-radius: 6px;
  --mail-tree-selected-bg: #d6e7fb;
  --mail-tree-count-bg: transparent;
  --mail-tree-count-ink: #8e8e93;

  --mail-chip-bg: #e5f1fb;
  --mail-chip-ink: #1c1c1e;

  --mail-search-bg: #e9e9ec;
  --mail-search-border: transparent;
  --mail-search-radius: 999px;

  --mail-action-radius: 5px;

  --mail-pane-bg: #fff;
  --mail-pane-border: transparent;
  --mail-pane-header-bg: #fff;
}
`;

const dark = `
/* Mac Mail dark — the system dark neutrals; system blue is unchanged. */
:root[data-theme="dark"] {
  --bg: #1e1e1e;
  --surface: #2c2c2e;
  --text: #f2f2f7;
  --muted: #98989d;
  --border: #38383a;
  --field: #2c2c2e;
  --highlight: #2c2c2e;

  --mail-sidebar-fallback: #232325;
  --mail-sidebar-bg: rgba(40, 40, 42, 0.72);

  --mail-list-bg: #2c2c2e;
  --mail-list-border: #38383a;
  --mail-list-row-bg: #2c2c2e;
  --mail-list-row-border: #333335;
  --mail-hover-bg: #3a3a3c;
  --mail-selected-bg: #1c4f86;

  --mail-tree-selected-bg: #1c4f86;
  --mail-tree-count-ink: #98989d;

  --mail-pane-bg: #2c2c2e;
  --mail-pane-header-bg: #2c2c2e;
  --mail-chip-bg: #1c4f86;
  --mail-chip-ink: #f2f2f7;
}
`;

const componentOverrides = `
/* ── Mac Mail chrome (unified window toolbar, vibrancy, flush hairlines) ── */
.sure-mail-app__top {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  gap: 0.75rem;
}
.sure-mail-app__lights { display: flex; gap: 8px; }
.sure-mail-app__light { width: 12px; height: 12px; border-radius: 50%; }
.sure-mail-app__light--close { background: var(--error); }
.sure-mail-app__light--min { background: var(--warn); }
.sure-mail-app__light--max { background: var(--success); }
.sure-mail-app__brand { width: 14.5rem; font-size: 1rem; font-weight: 600; color: var(--text); }
.sure-mail-app__search { order: 2; flex: 1 1 auto; max-width: 22rem; position: relative; }
.sure-mail-app__search-icon {
  position: absolute; left: 0.55rem; top: 50%; transform: translateY(-50%);
  width: 13px; height: 13px; color: var(--muted); pointer-events: none;
}
.sure-mail-app__search .sure-mail-search__input { padding-left: 1.8rem; }
.sure-mail-app__new {
  order: 3; margin-left: auto;
  display: inline-flex; align-items: center; gap: 6px;
  border-radius: 6px; padding: 5px 12px; font-size: 1rem;
}
.sure-mail-app__new svg { width: 14px; height: 14px; display: block; }
.sure-mail-app__actions { order: 4; }
.sure-mail-app__end { order: 5; display: flex; align-items: center; gap: 0.5rem; }
.sure-mail-app__avatar { display: none; }

/* Vibrancy sidebar: a solid fallback always paints, blur upgrades under
   @supports (both colours are skin tokens). */
.sure-mail-app__rail {
  background: var(--mail-sidebar-fallback);
  border-right: 1px solid var(--border);
  border-radius: 0;
}
@supports ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px))) {
  .sure-mail-app__rail {
    background: var(--mail-sidebar-bg);
    -webkit-backdrop-filter: saturate(180%) blur(20px);
    backdrop-filter: saturate(180%) blur(20px);
  }
}
.sure-mail-app__rail-new { display: none; }
.sure-mail-app__rail-section {
  margin: 0.9rem 0 0.3rem; padding: 0 0.55rem;
  font-size: 0.85rem; font-weight: 600; color: var(--muted);
}
.sure-mail-app__rail-section:first-child { margin-top: 0.25rem; }
.sure-mail-app__rail .sure-mail-tree__item { font-size: 1rem; }
.sure-mail-app__account { display: none; }

/* Center: slim header over one flush list surface, hairlines not cards. */
.sure-mail-app__list {
  background: var(--mail-list-bg);
  border-left: 1px solid var(--border); border-right: 1px solid var(--border);
  padding: 0; gap: 0;
}
.sure-mail-app__list-head {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid var(--border);
}
.sure-mail-app__list-tabs { display: none; }
.sure-mail-app__sort { font-size: 0.85rem; color: var(--muted); }
.sure-mail-app__selection { margin-left: auto; font-size: 0.85rem; color: var(--muted); }
.sure-mail-app__list .sure-mail-list { border: none; }
.sure-mail-app__unread-dot {
  display: none; width: 8px; height: 8px; border-radius: 50%;
  background: var(--mail-accent-alias);
}
.sure-mail-row--unread .sure-mail-app__unread-dot { display: inline-block; }
.sure-mail-app__list .sure-mail-row__check input { display: none; }

.sure-mail-app__reading { border-left: 1px solid var(--border); background: var(--mail-pane-bg); }
.sure-mail-app__read-toolbar {
  display: flex; align-items: center; gap: 0.15rem;
  padding: 0.3rem 0.55rem;
  border-bottom: 1px solid var(--border);
}
.sure-mail-app__status { display: none; }

.sure-mail-app__compose { align-items: flex-end; justify-content: flex-end; }
.sure-mail-app__compose .sure-mail-compose {
  width: min(25rem, 100%); border: none; border-radius: 10px;
  box-shadow: 0 12px 32px color-mix(in srgb, var(--text) 20%, transparent);
}
`;

const mobile = `
/* Mac Mail on a phone: the sidebar folds, list and reading stack. */
@media (max-width: 780px) {
  .sure-mail-app {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: "top" "list" "reading" "status";
    grid-template-rows: auto minmax(0, 1fr) minmax(0, 1fr) auto;
  }
  .sure-mail-app__rail { display: none; }
  .sure-mail-app__brand { display: none; }
  .sure-mail-app__search { order: 1; max-width: none; }
  .sure-mail-app__new { order: 2; margin-left: 0; }
}
`;

export const macmailSkin: SkinSpec = {
  id: "macmail",
  name: "Mac Mail",
  stackedList: false,
  layout: MACMAIL_LAYOUT,
  componentOverrides,
  tokens,
  dark,
  mobile,
};
