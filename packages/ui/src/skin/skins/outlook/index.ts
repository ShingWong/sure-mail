// Outlook Online — second skin in the D6 build order.
// Tokens ported from sure-ui's measured reference composition
// (experiments/mail-outlook/outlook-skin.css, 31/31 fidelity checks). The
// chrome (flat blue header, folder pane + Focused/Other pivot, message header
// card) lands in its own commit on top of this token/layout block.
import { OUTLOOK_LAYOUT } from "../../layout.ts";
import type { SkinSpec } from "../../types.ts";

const tokens = `
/* Outlook Online — Segoe UI-first at 14px, #0078d4 accent, two-line 56px rows. */
:root {
  --font-body: "Segoe UI", "Segoe UI Web (West European)", system-ui, -apple-system, BlinkMacSystemFont, Roboto, "Helvetica Neue", sans-serif;
  --font-size: 87.5%;

  --bg: #f5f5f5;
  --surface: #fff;
  --text: #201f1e;
  --muted: #605e5c;
  --border: #e1dfdd;
  --field: #f0f0f0;
  --highlight: #f3f2f1;
  --accent: #0078d4;
  --focus: #0078d4;
  --on-accent: #fff;
  --primary: #0078d4;
  --primary-hover: #106ebe;
  --primary-ink: #fff;

  --mail-accent-alias: #0078d4;
  --mail-accent-ink: #fff;
  --mail-flag-ink: #d13438;

  --mail-radius: 8px;
  --mail-list-bg: #fff;
  --mail-list-border: #e1dfdd;
  --mail-list-row-bg: #fff;
  --mail-list-row-border: #f3f2f1;
  --mail-hover-bg: #f3f2f1;
  --mail-unread-bg: #fff;
  --mail-unread-weight: 700;
  --mail-selected-bg: #eff6fc;

  --mail-list-row-h: calc(32px * var(--mail-density));
  --mail-list-line-h: calc(24px * var(--mail-density));

  --mail-tree-item-radius: 4px;
  --mail-tree-selected-bg: #f3f2f1;
  --mail-tree-count-bg: transparent;
  --mail-tree-count-ink: #605e5c;

  --mail-search-bg: #f0f0f0;
  --mail-search-border: transparent;
  --mail-search-radius: 999px;

  --mail-action-radius: 4px;

  --mail-chip-bg: #f3f2f1;
  --mail-chip-ink: #201f1e;

  --mail-pane-bg: #fff;
  --mail-pane-border: #e1dfdd;
  --mail-pane-header-bg: #fff;
  --mail-sidebar-bg: #fff;
}
`;

const dark = `
/* Outlook dark — Fluent dark neutrals; the accent stays #0078d4. */
:root[data-theme="dark"] {
  --bg: #1f1f1f;
  --surface: #292929;
  --text: #ffffff;
  --muted: #c8c6c4;
  --border: #3b3a39;
  --field: #333333;
  --highlight: #333333;

  --mail-list-bg: #292929;
  --mail-list-border: #3b3a39;
  --mail-list-row-bg: #292929;
  --mail-list-row-border: #333333;
  --mail-hover-bg: #333333;
  --mail-selected-bg: #0b3a5c;

  --mail-tree-selected-bg: #333333;
  --mail-pane-bg: #292929;
  --mail-pane-border: #3b3a39;
  --mail-pane-header-bg: #292929;
  --mail-sidebar-bg: #1f1f1f;
}
`;

const componentOverrides = `
/* ── Outlook chrome (Fluent: flat app bar, cards, blue primary) ──────── */
.sure-mail-app__top {
  background: var(--mail-list-bg);
  border-bottom: 1px solid var(--mail-list-border);
}
.sure-mail-app__brand { font-weight: 600; color: var(--muted); }
.sure-mail-app__new { display: none; }
.sure-mail-app__search { position: relative; flex: 1 1 auto; width: min(42rem, 100%); margin-inline: auto; }
.sure-mail-app__search-icon {
  position: absolute; left: 0.6rem; top: 50%; transform: translateY(-50%);
  width: 14px; height: 14px; color: var(--muted); pointer-events: none;
}
.sure-mail-app__search .sure-mail-search__input { padding-left: 1.9rem; }
.sure-mail-app__end { display: flex; align-items: center; gap: 0.5rem; }
.sure-mail-app__avatar {
  width: 2rem; height: 2rem; border-radius: 50%;
  display: grid; place-items: center;
  background: var(--mail-accent-alias); color: var(--mail-accent-ink);
  font-size: 0.75rem; font-weight: 700;
}

.sure-mail-app__rail {
  background: var(--mail-list-bg);
  border: 1px solid var(--mail-list-border);
  border-radius: var(--mail-radius);
}
.sure-mail-app__rail-new {
  display: inline-flex; align-items: center; gap: 0.5rem;
  justify-content: flex-start; width: 100%;
  margin: 0 0 0.5rem; border-radius: 4px; padding: 0.55rem 1rem;
}
.sure-mail-app__rail-new svg { width: 16px; height: 16px; display: block; }
.sure-mail-app__rail-section { display: none; }
.sure-mail-app__rail .sure-mail-tree__item { border-radius: 4px; }

/* One white list card: Focused/Other pivot + Sort over the stacked rows. */
.sure-mail-app__list {
  background: var(--mail-list-bg);
  border: 1px solid var(--mail-list-border);
  border-radius: var(--mail-radius);
  padding: 0; gap: 0; overflow: hidden;
}
.sure-mail-app__list-head {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0 0.5rem; min-height: 2.4rem;
  border-bottom: 1px solid var(--mail-list-row-border);
}
.sure-mail-app__list-tabs { display: flex; gap: 0.25rem; }
.sure-mail-app__list-tabs .sure-mail-search__chip {
  border: none; border-radius: 0; border-bottom: 2px solid transparent;
  padding: 0.55rem 0.75rem 0.35rem; font-size: 0.9rem;
}
.sure-mail-app__list-tabs .sure-mail-search__chip.is-active,
.sure-mail-app__list-tabs .sure-mail-search__chip[aria-pressed="true"] {
  background: transparent; color: var(--text); font-weight: 600;
  border-bottom: 2px solid var(--mail-accent-alias);
}
.sure-mail-app__sort { margin-left: auto; font-size: 0.8rem; color: var(--muted); }
.sure-mail-app__selection { font-size: 0.8rem; color: var(--muted); }
.sure-mail-app__list .sure-mail-list { border: none; border-radius: 0; }
.sure-mail-app__unread-dot {
  display: none; width: 8px; height: 8px; border-radius: 50%;
  background: var(--mail-accent-alias);
}
.sure-mail-row--unread .sure-mail-app__unread-dot { display: inline-block; }
.sure-mail-row--unread:hover .sure-mail-app__unread-dot { display: none; }
.sure-mail-app__list .sure-mail-row__check input { accent-color: var(--mail-accent-alias); }

.sure-mail-app__reading { background: var(--mail-list-bg); }
.sure-mail-app__read-toolbar {
  display: flex; align-items: center; gap: 0.25rem;
  padding: 0.3rem 0.5rem;
  background: var(--mail-list-bg);
  border: 1px solid var(--mail-list-border);
  border-radius: var(--mail-radius);
}
.sure-mail-app__read-scroll { margin-top: 0.5rem; }
.sure-mail-app__read-scroll .sure-mail-thread { border: none; border-radius: 0; }
.sure-mail-app__status { display: none; }

.sure-mail-app__compose { align-items: flex-end; justify-content: flex-end; }
.sure-mail-app__compose .sure-mail-compose {
  width: min(26rem, 100%); max-height: 92%; border: none;
  border-radius: var(--mail-radius) var(--mail-radius) 0 0;
  box-shadow: 0 -2px 12px color-mix(in srgb, var(--text) 25%, transparent);
}
.sure-mail-app__compose .btn-primary { border-radius: 4px; }
`;

const mobile = `
/* Outlook on a phone: one column, the folder pane folds away. */
@media (max-width: 780px) {
  .sure-mail-app {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: "top" "list" "reading" "status";
    grid-template-rows: auto minmax(0, 1fr) minmax(0, 1fr) auto;
  }
  .sure-mail-app__rail { display: none; }
  .sure-mail-app__brand, .sure-mail-app__avatar { display: none; }
  .sure-mail-app__new {
    display: inline-flex; align-items: center; gap: 0.4rem;
    border-radius: 4px; padding: 0.5rem 0.9rem;
  }
  .sure-mail-app__new svg { width: 16px; height: 16px; display: block; }
  .sure-mail-app__search { width: auto; flex: 1 1 auto; }
}
`;

export const outlookSkin: SkinSpec = {
  id: "outlook",
  name: "Outlook Online",
  stackedList: true,
  layout: OUTLOOK_LAYOUT,
  componentOverrides,
  tokens,
  dark,
  mobile,
};
