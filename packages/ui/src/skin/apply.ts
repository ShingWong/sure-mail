// applySkin: hot-swap a skin in a live document without a reload and without
// touching component CSS. Two <style> elements: one holds the layered base
// (written once — it never changes between skins over the same theme), the
// other holds the skin overlay (the only bytes swapped).
import { composeSkin } from "./engine.ts";
import type { Skin } from "./types.ts";

export const BASE_STYLE_ID = "sure-mail-base";
export const OVERLAY_STYLE_ID = "sure-mail-skin";

function ensureStyle(doc: Document, id: string): HTMLStyleElement {
  const found = doc.getElementById(id);
  if (found instanceof HTMLStyleElement) return found;
  const el = doc.createElement("style");
  el.id = id;
  doc.head.appendChild(el);
  return el;
}

/** Install/refresh the skin in `doc`. Returns the overlay element. */
export function applySkin(doc: Document, skin: Skin): HTMLStyleElement {
  const { base, overlay } = composeSkin(skin);
  const baseEl = ensureStyle(doc, BASE_STYLE_ID);
  if (baseEl.textContent !== base) baseEl.textContent = base;
  const overlayEl = ensureStyle(doc, OVERLAY_STYLE_ID);
  overlayEl.textContent = overlay;
  overlayEl.dataset.skin = skin.id;
  return overlayEl;
}
