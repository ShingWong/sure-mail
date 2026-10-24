// Thunderbird 115+ Supernova — fourth skin in the D6 build order.
// Tokens ported from sure-ui's measured reference composition
// (experiments/mail-thunderbird/thunderbird-skin.css, 55/55 fidelity checks;
// values pinned from comm-central's theme source). Thunderbird's chrome — the
// tab bar above the panes, the unified toolbar icon strip, coloured folder
// icons and the status footer — lands in its own commit on top of this block.
import { THUNDERBIRD_LAYOUT } from "../../layout.ts";
import type { SkinSpec } from "../../types.ts";

const tokens = `
/* Thunderbird 115+ Supernova — Bolt palette (#1373d9), 3px white cards on
   #fafafa, warm-orange flags, GREEN unread dots, 46px single-line rows. */
:root {
  --font-body: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Helvetica, Arial, sans-serif;
  --font-size: 87.5%;

  --bg: #fafafa;
  --surface: #ffffff;
  --text: #18181b;
  --muted: #71717a;
  --border: #d9d9de;
  --field: #f7f7f8;
  --highlight: #efeff1;
  --accent: #1373d9;
  --focus: #1373d9;
  --on-accent: #ffffff;
  --primary: #1373d9;
  --primary-hover: #175fb6;
  --primary-ink: #ffffff;

  --mail-flag-ink: #ea580c;

  --mail-list-bg: #fafafa;
  --mail-list-row-border: #d9d9de;
  --mail-radius: 3px;
  --mail-list-row-h: calc(46px * var(--mail-density));
  --mail-hover-bg: #e7f1fb;
  --mail-unread-bg: #ffffff;
  --mail-selected-bg: #dceaf9;

  --mail-tree-selected-bg: var(--accent);
  --mail-tree-count-bg: #71717a;
  --mail-tree-count-ink: #ffffff;

  --mail-action-size: 32px;
  --mail-icon-size: 16px;

  --mail-pane-border: transparent;

  --mail-sidebar-bg: #f4f4f5;
  --mail-sidebar-fallback: #f4f4f5;
  --thread-pane-unread-fill: #16a34a;

  /* Shell-consumed chrome tokens (same names Thunderbird uses upstream). */
  --treeitem-background-hover: #e4e4e7;
  --chrome-content-separator-color: #d4d4d8;
  --folder-color-draft: #ae55f7;
  --folder-color-sent: #1d783b;
  --folder-color-spam: #b91c1c;
  --folder-color-archive: #713f12;
  --folder-color-trash: #52525b;
}
`;

const dark = `
/* Thunderbird dark — the Bolt dark surfaces; Bolt blue is unchanged. */
:root[data-theme="dark"] {
  --bg: #1c1b22;
  --surface: #2b2a33;
  --text: #fbfbfe;
  --muted: #cfcfd8;
  --border: #52525e;
  --field: #2b2a33;
  --highlight: #3a3944;

  --mail-list-bg: #1c1b22;
  --mail-list-row-border: #52525e;
  --mail-list-row-bg: #2b2a33;
  --mail-hover-bg: #253a52;
  --mail-unread-bg: #2b2a33;
  --mail-selected-bg: #1f3b5c;

  --mail-tree-selected-bg: var(--accent);
  --mail-tree-count-bg: #52525e;

  --mail-pane-bg: #2b2a33;
  --mail-pane-header-bg: #2b2a33;
  --mail-sidebar-bg: #23222a;
  --treeitem-background-hover: #3a3944;
}
`;

const componentOverrides = `
/* ── Thunderbird chrome (tab bar, unified toolbar, card view, status) ── */
.sure-mail-app__tabbar {
  display: flex; align-items: stretch; gap: 1px;
  min-height: 33px; padding: 3px 3px 0;
  background: var(--mail-sidebar-bg);
}
.sure-mail-app__tab {
  position: relative;
  display: inline-flex; align-items: center; gap: 6px;
  min-height: 33px; padding: 8px 9px 5px;
  border: none; border-radius: 4px 4px 0 0;
  background: transparent; color: var(--text);
  font-size: 16px; line-height: 1.2; cursor: pointer;
}
.sure-mail-app__tab:hover { background: color-mix(in srgb, var(--text) 10%, transparent); }
.sure-mail-app__tab.is-active {
  background: var(--bg); color: var(--text); border-color: transparent;
}
.sure-mail-app__tab-line {
  position: absolute; top: 3px; left: 3px; right: 3px;
  height: 2px; border-radius: 3px; background: var(--accent); display: none;
}
.sure-mail-app__tab.is-active .sure-mail-app__tab-line { display: block; }
.sure-mail-app__tab-icon { display: inline-flex; flex-shrink: 0; width: 16px; height: 16px; }
.sure-mail-app__tab-icon svg { width: 100%; height: 100%; display: block; }
.sure-mail-app__tab-label { white-space: nowrap; }
.sure-mail-app__tab-close {
  display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; margin-right: -2px;
  font-size: 11px; line-height: 1; color: var(--text); opacity: 0.6;
  border-radius: 3px;
}
.sure-mail-app__tab-close:hover { opacity: 1; background: color-mix(in srgb, var(--text) 12%, transparent); }

.sure-mail-app__top {
  background: var(--bg);
  border-bottom: 1px solid var(--chrome-content-separator-color);
  gap: 0.35rem;
}
.sure-mail-app__brand, .sure-mail-app__lights { display: none; }
.sure-mail-app__new {
  display: inline-flex; align-items: center; gap: 0.4rem;
  border-radius: 3px; padding: 6px 14px; font-size: 1rem;
}
.sure-mail-app__new svg { width: 16px; height: 16px; display: block; }
.sure-mail-app__actions { display: flex; align-items: center; gap: 0.1rem; }
.sure-mail-app__actions .sure-mail-action { width: 32px; height: 32px; border-radius: 3px; }
.sure-mail-app__actions .sure-mail-action svg { width: 16px; height: 16px; }
.sure-mail-app__actions .sure-mail-action:hover { background: color-mix(in srgb, var(--text) 10%, transparent); }
.sure-mail-app__search { position: relative; margin-left: auto; width: min(16rem, 40%); }
.sure-mail-app__search-icon {
  position: absolute; left: 0.55rem; top: 50%; transform: translateY(-50%);
  width: 13px; height: 13px; color: var(--muted); pointer-events: none;
}
.sure-mail-app__search .sure-mail-search__input { padding-left: 1.75rem; }
.sure-mail-app__avatar { display: none; }

.sure-mail-app__rail {
  background: var(--mail-sidebar-bg);
  border-right: 1px solid var(--border);
  border-radius: 0;
  padding: 0.5rem 0.6rem 1rem;
}
.sure-mail-app__rail-new { display: none; }
.sure-mail-app__rail-section {
  margin: 0.9rem 0 0.35rem; padding: 0 0.5rem;
  font-size: 0.8rem; font-weight: 600; color: var(--muted);
}
.sure-mail-app__rail-section:first-child { margin-top: 0.25rem; }
.sure-mail-app__rail .sure-mail-tree__item { font-size: 1rem; }
.sure-mail-app__rail .sure-mail-tree__item.is-selected { color: var(--on-accent); }
.sure-mail-app__rail .sure-mail-tree__item:hover { background: var(--treeitem-background-hover); }
.sure-mail-app__rail .sure-mail-tree__item[data-folder="draft"] .sure-mail-tree__icon { color: var(--folder-color-draft); }
.sure-mail-app__rail .sure-mail-tree__item[data-folder="sent"] .sure-mail-tree__icon { color: var(--folder-color-sent); }
.sure-mail-app__rail .sure-mail-tree__item[data-folder="junk"] .sure-mail-tree__icon { color: var(--folder-color-spam); }
.sure-mail-app__rail .sure-mail-tree__item[data-folder="archive"] .sure-mail-tree__icon { color: var(--folder-color-archive); }
.sure-mail-app__rail .sure-mail-tree__item[data-folder="trash"] .sure-mail-tree__icon { color: var(--folder-color-trash); }
.sure-mail-app__account { display: none; }

/* Card view: white 3px cards with hairlines on the grey tree pane. */
.sure-mail-app__list { background: var(--mail-list-bg); padding: 2px 3px; gap: 0; }
.sure-mail-app__list-head { display: none; }
.sure-mail-app__list .sure-mail-list { border: none; padding: 2px 3px; gap: 4px; }
.sure-mail-app__list .sure-mail-row {
  border: 1px solid var(--mail-list-row-border);
  border-radius: var(--mail-radius);
}
.sure-mail-app__list .sure-mail-row:hover {
  border-color: color-mix(in srgb, var(--mail-accent-alias) 70%, transparent);
}
.sure-mail-app__list .sure-mail-row--selected,
.sure-mail-app__list .sure-mail-row[aria-selected="true"] {
  border-color: color-mix(in srgb, var(--mail-accent-alias) 30%, transparent);
}
.sure-mail-app__list .sure-mail-row__check { position: relative; }
.sure-mail-app__list .sure-mail-row__check input { opacity: 0; }
.sure-mail-app__list .sure-mail-row__flag { opacity: 0; }
.sure-mail-app__list .sure-mail-row:hover .sure-mail-row__flag,
.sure-mail-app__list .sure-mail-row:focus-within .sure-mail-row__flag,
.sure-mail-app__list .sure-mail-row--flagged .sure-mail-row__flag { opacity: 1; }
.sure-mail-app__unread-dot {
  display: none; width: 8px; height: 8px; border-radius: 50%;
  background: var(--thread-pane-unread-fill);
}
.sure-mail-row--unread .sure-mail-app__unread-dot { display: block; }
.sure-mail-row--unread:hover .sure-mail-app__unread-dot { display: none; }

.sure-mail-app__reading {
  border-left: 1px solid var(--mail-pane-border);
  background: var(--mail-pane-bg);
}
.sure-mail-app__read-toolbar {
  gap: 0.1rem; padding: 4px 6px;
  background: var(--bg);
  border-bottom: 1px solid var(--mail-list-row-border);
}
.sure-mail-app__read-toolbar .sure-mail-action { width: 32px; height: 32px; border-radius: 3px; }
.sure-mail-app__read-toolbar .sure-mail-action svg { width: 16px; height: 16px; }
.sure-mail-app__read-toolbar .sure-mail-action:hover { background: color-mix(in srgb, var(--text) 10%, transparent); }

.sure-mail-app__status {
  min-height: 22px; padding: 0 8px;
  justify-content: space-between;
  background: var(--bg);
  border-top: 1px solid var(--border);
}

.sure-mail-app__compose { align-items: flex-end; justify-content: flex-end; }
.sure-mail-app__compose .sure-mail-compose {
  width: min(25rem, 100%); border: none; border-radius: 8px;
  box-shadow: 0 12px 32px color-mix(in srgb, var(--text) 20%, transparent);
}
.sure-mail-app__compose .btn-primary { border-radius: 3px; }
`;

const mobile = `
/* Thunderbird on a phone: the tab bar and folder pane fold away. */
@media (max-width: 780px) {
  .sure-mail-app {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: "top" "list" "reading" "status";
    grid-template-rows: auto minmax(0, 1fr) minmax(0, 1fr) auto;
  }
  .sure-mail-app__tabbar { display: none; }
  .sure-mail-app__rail { display: none; }
}
`;

export const thunderbirdSkin: SkinSpec = {
  id: "thunderbird",
  name: "Thunderbird",
  stackedList: false,
  layout: THUNDERBIRD_LAYOUT,
  componentOverrides,
  tokens,
  dark,
  mobile,
};
