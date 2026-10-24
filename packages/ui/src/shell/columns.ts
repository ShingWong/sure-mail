// Adjustable list columns: which are shown, and how wide.
//
// The row layout belongs to the skins, so this is opt-in: with columns off the
// list renders exactly as before (and the visual baselines stay meaningful).
// Turning it on adds a header with drag grips and pins the From/Date widths;
// the choice and the widths are remembered per browser.
export interface ColumnState {
  enabled: boolean;
  /** Width of the From column, in px. */
  from: number;
  /** Width of the Date column, in px. */
  date: number;
  showFrom: boolean;
  showDate: boolean;
}

export const MIN_COLUMN = 72;
export const MAX_COLUMN = 420;

export const DEFAULT_COLUMNS: ColumnState = {
  enabled: false,
  from: 168,
  date: 92,
  showFrom: true,
  showDate: true,
};

const KEY = "sure-mail-columns";

export function loadColumns(): ColumnState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_COLUMNS };
    const parsed = JSON.parse(raw) as Partial<ColumnState>;
    return {
      enabled: parsed.enabled ?? DEFAULT_COLUMNS.enabled,
      from: clamp(parsed.from ?? DEFAULT_COLUMNS.from),
      date: clamp(parsed.date ?? DEFAULT_COLUMNS.date),
      showFrom: parsed.showFrom ?? DEFAULT_COLUMNS.showFrom,
      showDate: parsed.showDate ?? DEFAULT_COLUMNS.showDate,
    };
  } catch {
    // A private-mode browser or a corrupted value: the default is fine.
    return { ...DEFAULT_COLUMNS };
  }
}

export function saveColumns(state: ColumnState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Not being able to remember the widths must not break the list.
  }
}

export function clamp(px: number): number {
  if (!Number.isFinite(px)) return MIN_COLUMN;
  return Math.max(MIN_COLUMN, Math.min(MAX_COLUMN, Math.round(px)));
}
