// Gmail (desktop web) — the first skin in the D6 build order.
// Tokens ported from sure-ui's measured reference composition
// (experiments/mail-gmail/gmail-skin.css, 15/15 fidelity checks); the chrome
// block turns the shared shell markup into Gmail's window: a flat white app
// bar with a round avatar, a white rounded nav rail with a compose pill, one
// rounded list card with a hover toolbar, and a white reading pane.
import { GMAIL_LAYOUT } from "../../layout.ts";
import type { SkinSpec } from "../../types.ts";

const tokens = `
/* Gmail — Roboto-first stack, #1a73e8 accent, 40px rows, pill rail. */
:root {
  --font-body: Roboto, "Helvetica Neue", Arial, sans-serif;

  --bg: #f1f3f4;
  --surface: #fff;
  --text: #202124;
  --muted: #5f6368;
  --border: #dadce0;
  --field: #f1f3f4;
  --highlight: #f1f3f4;
  --accent: #1a73e8;
  --focus: #1a73e8;
  --on-accent: #fff;
  --primary: #c2e7ff;
  --primary-hover: #a8d3f7;
  --primary-ink: #001d35;

  --mail-accent-alias: #1a73e8;
  --mail-accent-ink: #fff;

  --mail-list-bg: #fff;
  --mail-list-border: transparent;
  --mail-list-row-bg: #fff;
  --mail-list-row-border: #eceef1;
  --mail-list-row-h: calc(40px * var(--mail-density));
  --mail-list-sender-w: 15rem;
  --mail-hover-bg: #f2f2f2;
  --mail-unread-bg: #f6fafe;
  --mail-unread-weight: 700;
  --mail-selected-bg: #e8f0fe;
  --mail-flag-ink: #f9ab00;

  --mail-tree-item-radius: 999px;
  --mail-tree-selected-bg: #d3e3fd;

  --mail-search-bg: #f1f3f4;
  --mail-search-border: transparent;
  --mail-search-radius: 999px;

  --mail-action-radius: 50%;

  --mail-chip-bg: #e8f0fe;
  --mail-chip-ink: #001d35;

  --mail-pane-bg: #fff;
  --mail-pane-border: transparent;
  --mail-pane-header-bg: #fff;
  --mail-sidebar-bg: #f1f3f4;
}
`;

const dark = `
/* Gmail dark — the same geometry on Gmail's dark surfaces (#202124 canvas). */
:root[data-theme="dark"] {
  --bg: #202124;
  --surface: #292a2d;
  --text: #e8eaed;
  --muted: #9aa0a6;
  --border: #5f6368;
  --field: #3c4043;
  --highlight: #3c4043;
  --accent: #8ab4f8;
  --focus: #8ab4f8;
  --on-accent: #202124;
  --primary: #8ab4f8;
  --primary-hover: #aecbfa;
  --primary-ink: #202124;

  --mail-accent-alias: #8ab4f8;
  --mail-accent-ink: #202124;

  --mail-list-bg: #292a2d;
  --mail-list-row-bg: #292a2d;
  --mail-list-row-border: #3c4043;
  --mail-hover-bg: #35363a;
  --mail-unread-bg: #2a2e33;
  --mail-selected-bg: #394457;
  --mail-flag-ink: #fdd663;

  --mail-tree-selected-bg: #394457;
  --mail-pane-bg: #292a2d;
  --mail-pane-header-bg: #292a2d;
  --mail-sidebar-bg: #202124;

  --mail-search-bg: #3c4043;
  --mail-chip-bg: #3c4043;
  --mail-chip-ink: #e8eaed;
}
`;

const componentOverrides = `
/* ── Gmail chrome (structure over the shell's own classes) ───────────── */
.sure-mail-app__top {
  background: var(--mail-list-bg);
  border-bottom: 0;
}
.sure-mail-app__brand {
  width: 12rem; font-weight: 700; font-size: 1.15rem; color: var(--muted);
}
.sure-mail-app__search { position: relative; flex: 1 1 auto; max-width: 44rem; }
.sure-mail-app__search-icon { display: none; }
.sure-mail-app__new { display: none; }
.sure-mail-app__actions { display: flex; align-items: center; gap: 0.35rem; }
.sure-mail-app__end { margin-left: auto; display: flex; align-items: center; gap: 0.5rem; }
.sure-mail-app__avatar {
  width: 2rem; height: 2rem; border-radius: 50%;
  display: grid; place-items: center;
  background: var(--mail-accent-alias); color: var(--mail-accent-ink);
  font-size: 0.75rem; font-weight: 700;
}

.sure-mail-app__rail {
  background: var(--mail-list-bg);
  border-radius: var(--mail-radius);
}
.sure-mail-app__rail-new {
  justify-content: center; margin: 0 0.5rem 0.875rem;
  border-radius: 999px; padding: 0.75rem 1.25rem;
  box-shadow: 0 1px 3px color-mix(in srgb, var(--text) 20%, transparent);
}
.sure-mail-app__rail-new svg { width: 18px; height: 18px; display: block; }
.sure-mail-app__rail-section, .sure-mail-app__account { display: none; }

/* One rounded list card carrying the selection toolbar over the list. */
.sure-mail-app__list {
  background: var(--mail-list-bg);
  border-radius: 0.5rem;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--text) 14%, transparent);
  overflow: hidden;
}
.sure-mail-app__list-head {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.35rem 0.5rem;
}
.sure-mail-app__list-tabs { display: none; }
.sure-mail-app__sort { display: none; }
.sure-mail-app__selection { margin-left: auto; font-size: 0.8rem; color: var(--muted); }
.sure-mail-app__list .sure-mail-list { border: none; border-radius: 0; flex: 1 1 auto; }
.sure-mail-app__unread-dot { display: none; }
.sure-mail-app__list .sure-mail-row__check input { accent-color: var(--mail-accent-alias); }

.sure-mail-app__reading { background: var(--mail-pane-bg); }
.sure-mail-app__read-toolbar {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.35rem 0.75rem;
  border-bottom: 1px solid var(--mail-list-row-border);
}
.sure-mail-app__read-scroll { min-height: 0; overflow-y: auto; flex: 1 1 auto; }
.sure-mail-app__read-scroll .sure-mail-thread { border: none; border-radius: 0; }
.sure-mail-app__status { display: none; }

.sure-mail-app__compose { align-items: flex-end; justify-content: flex-end; }
.sure-mail-app__compose .sure-mail-compose {
  width: min(26rem, 100%); max-height: 92%;
  border: none; border-radius: 0.5rem 0.5rem 0 0;
  box-shadow: 0 -2px 12px color-mix(in srgb, var(--text) 25%, transparent);
}
`;

const mobile = `
/* Gmail on a phone: one column, the rail folds away, reading stacks under. */
@media (max-width: 780px) {
  .sure-mail-app {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: "top" "list" "reading" "status";
    grid-template-rows: auto minmax(0, 1fr) minmax(0, 1fr) auto;
  }
  .sure-mail-app__rail { display: none; }
  .sure-mail-app__brand { display: none; }
  .sure-mail-app__new {
    display: inline-flex; align-items: center; gap: 0.4rem;
    border-radius: 999px; padding: 0.5rem 0.9rem;
  }
  .sure-mail-app__new svg { width: 18px; height: 18px; display: block; }
  .sure-mail-app__list { border-radius: 0; box-shadow: none; padding: 0; }
  .sure-mail-app__avatar { display: none; }
}
`;

export const gmailSkin: SkinSpec = {
  id: "gmail",
  name: "Gmail",
  stackedList: false,
  layout: GMAIL_LAYOUT,
  componentOverrides,
  tokens,
  dark,
  mobile,
};
