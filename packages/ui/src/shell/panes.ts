// Resizable panes: the dividers between the folder rail, the message list and
// the reading pane.
//
// The skins own the grid ("15rem 30rem minmax(0,1fr)"), so nothing here is
// applied until the user drags: the shell keeps its skin geometry, and a drag
// pins the two left tracks in pixels. Double-clicking a divider forgets that
// pane and returns to the skin's own widths, and the choice is remembered per
// browser.
import { h } from "./h.ts";

export interface PaneState {
  rail: number | null;
  list: number | null;
}

export const PANE_DEFAULTS: PaneState = { rail: null, list: null };

const KEY = "sure-mail-panes";
const RAIL_MIN = 132;
const RAIL_MAX = 420;
const LIST_MIN = 240;
const LIST_MAX = 760;

export function loadPanes(): PaneState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...PANE_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<PaneState>;
    return {
      rail: typeof parsed.rail === "number" ? parsed.rail : null,
      list: typeof parsed.list === "number" ? parsed.list : null,
    };
  } catch {
    return { ...PANE_DEFAULTS };
  }
}

function savePanes(state: PaneState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Remembering widths is a convenience, never a requirement.
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(v)));

/** The first two track sizes of the shell's grid, in px. */
function tracks(root: HTMLElement): number[] {
  const value = getComputedStyle(root).gridTemplateColumns;
  return value
    .split(" ")
    .map((t) => Number.parseFloat(t))
    .filter((n) => Number.isFinite(n));
}

export interface PaneResizer {
  /** Re-apply the saved widths (after a skin change, the grid is new). */
  apply(): void;
  destroy(): void;
}

/**
 * Install the two grips. `rail` and `list` are the panes whose widths change;
 * the reading pane takes the remaining space.
 */
export function installPaneResizer(
  root: HTMLElement,
  rail: HTMLElement,
  list: HTMLElement,
  state: PaneState = loadPanes(),
): PaneResizer {
  const current: PaneState = { ...state };
  const grips: HTMLElement[] = [];

  const apply = (): void => {
    const now = tracks(root);
    if (now.length < 3) return; // stacked/mobile: one column, nothing to drag
    const [rest] = [now[2]];
    const railW = current.rail ?? now[0];
    const listW = current.list ?? now[1];
    if (current.rail === null && current.list === null) {
      root.style.removeProperty("grid-template-columns");
      return;
    }
    // Keep the reading pane honest when a fixed pair would leave it too narrow.
    const total = root.clientWidth;
    const reading = Math.max(220, total - railW - listW);
    root.style.gridTemplateColumns = `${railW}px ${listW}px minmax(0, 1fr)`;
    if (railW + listW + reading > total) {
      // Shrink the list first: it is the pane people resize less often.
      const room = Math.max(LIST_MIN, total - railW - 220);
      current.list = clamp(room, LIST_MIN, LIST_MAX);
      root.style.gridTemplateColumns = `${railW}px ${current.list}px minmax(0, 1fr)`;
    }
    void rest;
    place();
  };

  const place = (): void => {
    if (tracks(root).length < 3) {
      for (const g of grips) g.hidden = true;
      return;
    }
    for (const g of grips) g.hidden = false;
    const [g0, g1] = grips;
    if (!g0 || !g1) return;
    const railBox = rail.getBoundingClientRect();
    const listBox = list.getBoundingClientRect();
    const top = railBox.top;
    const height = railBox.height;
    g0.style.transform = `translate(${Math.round(railBox.right - 3)}px, ${Math.round(top)}px)`;
    g0.style.height = `${Math.round(height)}px`;
    g1.style.transform = `translate(${Math.round(listBox.right - 3)}px, ${Math.round(top)}px)`;
    g1.style.height = `${Math.round(height)}px`;
  };

  const startDrag = (which: "rail" | "list") => (event: PointerEvent): void => {
    const grip = event.currentTarget as HTMLElement;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    const x0 = event.clientX;
    const now = tracks(root);
    if (now.length < 3) return;
    const railW0 = current.rail ?? now[0];
    const listW0 = current.list ?? now[1];

    const move = (e: PointerEvent): void => {
      const dx = e.clientX - x0;
      if (which === "rail") {
        current.rail = clamp(railW0 + dx, RAIL_MIN, RAIL_MAX);
      } else {
        current.list = clamp(listW0 + dx, LIST_MIN, LIST_MAX);
      }
      root.style.gridTemplateColumns = `${current.rail ?? railW0}px ${current.list ?? listW0}px minmax(0, 1fr)`;
      place();
    };
    const up = (): void => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      savePanes(current);
      // The reading pane and the list re-flow; nothing else needs a rebuild.
      window.dispatchEvent(new Event("resize"));
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  };

  const makeGrip = (which: "rail" | "list", label: string): HTMLElement => {
    const grip = h("div", {
      class: `sure-mail-pane-grip sure-mail-pane-grip--${which}`,
      role: "separator",
      "aria-orientation": "vertical",
      "aria-label": label,
      tabindex: 0,
      title: "Drag to resize · double-click to reset",
      onpointerdown: startDrag(which),
      ondblclick: () => {
        current[which] = null;
        savePanes(current);
        apply();
        window.dispatchEvent(new Event("resize"));
      },
      onkeydown: (event: KeyboardEvent) => {
        const step = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
        if (step === 0) return;
        event.preventDefault();
        const now = tracks(root);
        const base = current[which] ?? (which === "rail" ? now[0] : now[1]);
        current[which] = clamp(
          base + step,
          which === "rail" ? RAIL_MIN : LIST_MIN,
          which === "rail" ? RAIL_MAX : LIST_MAX,
        );
        apply();
        savePanes(current);
      },
    });
    root.append(grip);
    grips.push(grip);
    return grip;
  };

  root.classList.add("sure-mail-app--resizable");
  makeGrip("rail", "Resize folder list");
  makeGrip("list", "Resize message list");
  apply();

  const observer = new ResizeObserver(() => place());
  observer.observe(root);

  return {
    apply,
    destroy(): void {
      observer.disconnect();
      for (const g of grips) g.remove();
    },
  };
}
