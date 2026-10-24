// The skin catalog: the four Track B skins (the D6 build order: Gmail,
// Outlook Online, Mac Mail, Thunderbird), each a folder under skins/ that
// exports its unlayered layout, structural chrome and token palettes. All
// four compose over the same sure-ui base theme and component runs, so their
// layered component CSS is identical and only the unlayered overlay differs —
// the hot-swap proof.
import type { ComponentName } from "@shing.wong/sure-ui/compose";
import { SKIN_MODULES } from "./skins/index.ts";
import type { Skin } from "./types.ts";

/** The sure-ui families the shell renders: the six opt-in mail families plus
    the shared button primitives compose() needs for the compose window. */
export const SHELL_COMPONENTS: readonly ComponentName[] = [
  "mail-list",
  "mail-thread",
  "mail-folder-tree",
  "mail-compose",
  "mail-action-bar",
  "mail-search",
  "buttons",
];

const THEME = "nord";

export const SKINS: readonly Skin[] = SKIN_MODULES.map((spec) => ({
  ...spec,
  theme: THEME,
  components: SHELL_COMPONENTS,
}));

export const SKIN_IDS: readonly string[] = SKINS.map((s) => s.id);
export const DEFAULT_SKIN_ID = "gmail";

export function getSkin(id: string): Skin {
  const skin = SKINS.find((s) => s.id === id);
  if (!skin) throw new Error(`unknown skin "${id}" — valid: ${SKIN_IDS.join(", ")}`);
  return skin;
}
