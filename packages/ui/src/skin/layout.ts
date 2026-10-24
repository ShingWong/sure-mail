// App-shell layout CSS, shared scaffolding + one block per skin. This is
// UNLAYERED consumer CSS: it positions the shell's grid/regions and never
// styles a sure-ui component selector (the `.sure-mail-list`/`.sure-mail-thread`
// rules only set margin / border on the component's own box, which is exactly
// what a consumer page does). All colour comes from tokens; the four layouts
// differ in geometry, region count (Thunderbird adds the tab-bar row) and
// surface treatment.

export interface LayoutSpec {
  /** `grid-template-rows` for the shell (Thunderbird inserts the tab row). */
  rows?: string;
  /** `grid-template-columns` for the three-pane shell. */
  columns: string;
  /** `grid-template-areas` naming top/rail/list/reading/status (+ tabbar). */
  areas: string;
  /** Skin-specific region treatment (unlayered). */
  extra?: string;
}

export function layout({ rows = "auto minmax(0, 1fr) auto", columns, areas, extra = "" }: LayoutSpec): string {
  return `
/* ── Document reset (the shell owns the viewport) ──────────────────── */
html, body { margin: 0; height: 100%; }
#app { height: 100%; }

/* ── App shell: grid + regions (skin-owned, unlayered) ─────────────── */
.sure-mail-app {
  display: grid;
  grid-template-columns: ${columns};
  grid-template-rows: ${rows};
  grid-template-areas: ${areas};
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-body);
  font-size: var(--font-size, 100%);
  line-height: var(--line-height, 1.6);
}

/* The tab bar only exists where a skin grid names its row. */
.sure-mail-app__tabbar { display: none; }

/* Window controls: macOS chrome only; hidden everywhere else. */
.sure-mail-app__lights { display: none; }

.sure-mail-app__top {
  grid-area: top;
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: var(--mail-pane-header-bg, var(--surface));
}

.sure-mail-app__rail {
  grid-area: rail; min-height: 0; overflow: auto;
  padding: 0.5rem;
  background: var(--mail-sidebar-fallback, var(--mail-sidebar-bg, var(--bg)));
}
.sure-mail-app__rail .sure-mail-tree { width: 100%; }
.sure-mail-app__account {
  padding: 0.35rem 0.5rem 0.6rem;
  font-size: 0.8rem; color: var(--muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sure-mail-app__account-name { font-weight: 600; color: var(--text); }

.sure-mail-app__list {
  grid-area: list; min-height: 0;
  display: flex; flex-direction: column;
  padding: 0.5rem;
  background: var(--bg);
}
.sure-mail-app__list-body { flex: 1 1 auto; min-height: 0; overflow: auto; }
.sure-mail-app__list .sure-mail-list { min-height: 0; }
.sure-mail-app__reading {
  grid-area: reading; min-height: 0;
  display: flex; flex-direction: column;
  background: var(--mail-pane-bg, var(--bg));
}
.sure-mail-app__read-toolbar { display: flex; align-items: center; }
.sure-mail-app__read-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.sure-mail-app__reading .sure-mail-thread { min-height: 100%; }

.sure-mail-app__empty { padding: 1.25rem; color: var(--muted); font-size: 0.9rem; }
.sure-mail-app__result-folder { color: var(--muted); font-size: 0.75rem; }

/* Reading pane body: preserve plain-text shape (the shell never innerHTMLs). */
.sure-mail-app__body-text { white-space: pre-wrap; }

/* First-run account setup reuses the compose card, centred. */
.sure-mail-app__firstrun { padding: 2rem 1rem; max-width: 34rem; margin: 0 auto; }

.sure-mail-app__status {
  grid-area: status;
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.3rem 0.75rem;
  background: var(--mail-pane-header-bg, var(--surface));
  font-size: 0.75rem; color: var(--muted);
}

/* Compose: a floating panel bottom-right; skins restyle it through chrome. */
.sure-mail-app__compose {
  position: fixed; inset: 0; z-index: 20;
  display: flex; align-items: flex-end; justify-content: flex-end;
  padding: 1rem;
  background: color-mix(in srgb, var(--text) 18%, transparent);
}
.sure-mail-app__compose[hidden] { display: none; }
.sure-mail-app__compose .sure-mail-compose {
  width: min(42rem, 100%); max-height: 92%;
  box-shadow: 0 12px 40px color-mix(in srgb, var(--text) 30%, transparent);
}

/* First-run form: state why a static deploy cannot fetch, without hiding the
   form behind the explanation. Muted so it reads as a note, not an error. */
.sure-mail-compose__hint {
  margin: 0 0 0.9rem;
  font-size: 0.9rem;
  line-height: 1.45;
  color: var(--muted, color-mix(in srgb, var(--text) 65%, transparent));
}

/* Adjustable list columns: opt-in header + drag grips. Off by default, so the
   skins' row layout (and the visual baselines) are unchanged until asked for. */
.sure-mail-app__columns {
  padding: 0.1rem 0.5rem;
  font: inherit;
  font-size: 0.75rem;
  color: var(--muted);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 999px;
  cursor: pointer;
}
.sure-mail-app__columns[aria-pressed="true"] { color: var(--accent); border-color: var(--accent); }
.sure-mail-list__header {
  display: flex; align-items: center; gap: 0;
  padding: 0.2rem 0.75rem 0.2rem 3.1rem;
  font-size: 0.7rem; letter-spacing: 0.04em; text-transform: uppercase;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
  background: var(--mail-pane-header-bg, var(--surface));
}
.sure-mail-list__head {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding-right: 0.4rem;
}
.sure-mail-list__head--subject { flex: 1 1 auto; }
.sure-mail-list__grip {
  flex: 0 0 7px; align-self: stretch;
  cursor: col-resize;
  border-left: 1px solid transparent;
}
.sure-mail-list__grip:hover, .sure-mail-list__grip:focus-visible { border-left-color: var(--accent); outline: none; }
.sure-mail-list--adjustable .sure-mail-row__time { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Status bar action (Cancel sync): a quiet text button, not a primary action. */
.sure-mail-app__status-action {
  margin-left: auto;
  padding: 0.15rem 0.5rem;
  font: inherit;
  font-size: 0.8rem;
  color: var(--text);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 999px;
  cursor: pointer;
}
.sure-mail-app__status-action:hover { border-color: var(--accent); color: var(--accent); }

/* Settings dialog (skin + theme switcher) — the M5 runtime switch. */
.sure-mail-app__settings {
  position: fixed; inset: 0; z-index: 30;
  display: flex; align-items: center; justify-content: center;
  padding: 1rem;
  background: color-mix(in srgb, var(--text) 30%, transparent);
}
.sure-mail-app__settings[hidden] { display: none; }
.sure-mail-app__settings-card {
  width: min(26rem, 100%);
  display: flex; flex-direction: column; gap: 0.75rem;
  padding: 1.25rem;
  background: var(--surface); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--mail-radius, 0.5rem);
  box-shadow: 0 18px 48px color-mix(in srgb, var(--text) 28%, transparent);
}
.sure-mail-app__settings-card h2 { margin: 0; font-size: 1.05rem; }
.sure-mail-app__settings-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.sure-mail-app__settings-row select {
  font: inherit; padding: 0.3rem 0.5rem; min-width: 12rem;
  border: 1px solid var(--border); border-radius: var(--mail-radius, 0.5rem);
  background: var(--field); color: var(--text);
}
${extra}`;
}

export const GMAIL_LAYOUT = layout({
  columns: "15rem 30rem minmax(0, 1fr)",
  areas: '"top top top" "rail list reading" "status status status"',
  extra: `
.sure-mail-app__top { border-bottom: 0; padding: 0.5rem 1rem; gap: 1.25rem; }
.sure-mail-app__list { padding: 0.75rem; gap: 0.75rem; }
.sure-mail-app__rail { padding: 0.75rem 0.5rem; }
`,
});

export const OUTLOOK_LAYOUT = layout({
  columns: "16rem 26rem minmax(0, 1fr)",
  areas: '"top top top" "rail list reading" "status status status"',
  extra: `
.sure-mail-app__top { padding: 0.4rem 1rem; gap: 1rem; border-bottom: 1px solid var(--mail-list-border); }
.sure-mail-app__rail { background: var(--mail-sidebar-bg, var(--surface)); padding: 0.5rem; }
.sure-mail-app__list { padding: 0.5rem; gap: 0.5rem; }
.sure-mail-app__reading { padding: 0.5rem; gap: 0.5rem; }
`,
});

export const MACMAIL_LAYOUT = layout({
  columns: "14.5rem 22rem minmax(0, 1fr)",
  areas: '"top top top" "rail list reading" "status status status"',
  extra: `
.sure-mail-app__top { min-height: 44px; padding: 0 14px; gap: 1rem; border-bottom: 1px solid var(--border); }
.sure-mail-app__rail { padding: 0.6rem 0.6rem 1rem; }
.sure-mail-app__list { padding: 0; gap: 0; }
.sure-mail-app__reading { padding: 0; }
`,
});

export const THUNDERBIRD_LAYOUT = layout({
  rows: "auto auto minmax(0, 1fr) auto",
  columns: "15rem minmax(21rem, 38rem) minmax(0, 1fr)",
  areas: '"tabbar tabbar tabbar" "top top top" "rail list reading" "status status status"',
  extra: `
.sure-mail-app__tabbar { display: flex; }
.sure-mail-app__top { min-height: 40px; padding: 4px 8px; gap: 0.35rem; }
.sure-mail-app__rail { padding: 0.5rem 0.6rem 1rem; }
.sure-mail-app__list { padding: 0; gap: 0; }
.sure-mail-app__reading { padding: 0; }
.sure-mail-app__status { min-height: 22px; padding: 0 8px; }
`,
});
