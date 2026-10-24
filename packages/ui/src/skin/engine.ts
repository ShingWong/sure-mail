// composeSkin: assemble a skin through sure-ui's layer model. The component
// runs are compiled by compose() into the three cascade layers
// (@layer sure.tokens, sure.components, sure.mobile); the skin's layout,
// structural chrome, token overrides, dark palette and mobile tweaks are
// plain unlayered CSS appended after, so they always win over the theme and
// swapping a skin moves only those bytes — the layered component CSS is
// byte-identical across the four skins.
import { compose } from "@shing.wong/sure-ui/compose";
import type { Skin } from "./types.ts";

export interface ComposedSkin {
  /** Layered component CSS (shared by every skin over the same theme). */
  base: string;
  /** Unlayered layout + chrome + tokens/dark/mobile (the skin-specific bytes). */
  overlay: string;
}

/** The unlayered half of a skin, in cascade order. */
export function skinOverlay(skin: Skin): string {
  return [skin.layout, skin.componentOverrides, skin.tokens, skin.dark ?? "", skin.mobile ?? ""]
    .filter((part) => part.length > 0)
    .join("\n");
}

export function composeSkin(skin: Skin): ComposedSkin {
  const base = compose({ theme: skin.theme, components: skin.components });
  return { base, overlay: skinOverlay(skin) };
}

/** The full stylesheet for a skin: layered component CSS + unlayered overlay. */
export function renderSkin(skin: Skin): string {
  const { base, overlay } = composeSkin(skin);
  return `${base}\n${overlay}`;
}
