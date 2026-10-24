// A skin is the whole look of the app shell: the unlayered layout CSS that
// positions the regions, the structural chrome that turns the shared shell
// markup into one client's window, and the unlayered token overrides that
// paint both. Each skin folder exports a `SkinSpec`; the registry registers
// it in the catalog, binding the shared sure-ui theme and component runs.
// Nothing here carries a sure-ui component selector into the layered output —
// component CSS lives in the layered compose() output and is byte-identical
// for every skin (see engine.ts and the skin unit tests).
import type { ComponentName } from "@shing.wong/sure-ui/compose";

/**
 * What one skin folder exports (M5). The four Track B skins assemble it from
 * the measured reference compositions in sure-ui's `experiments/mail-*`.
 */
export interface SkinSpec {
  /** Stable id used in the picker and the `?skin=` query param. */
  id: string;
  /** Human-readable name, e.g. "Gmail". */
  name: string;
  /**
   * Structural flag the shell consumes: two-line list rows (the opt-in
   * `.sure-mail-list--stacked` modifier). CSS geometry still flows from the
   * skin's `--mail-list-line-h`; this only toggles the class.
   */
  stackedList: boolean;
  /** Unlayered app-grid/region CSS for this skin (consumer CSS wins). */
  layout: string;
  /**
   * Structural chrome over the shell's OWN classes (`sure-mail-app__*`, the
   * `sure-mail-row__*` slots): the tab bar, toolbar, list header, action
   * strip and so on. Unlayered, so it beats compose()'s three layers without
   * editing component CSS. Colour still flows from tokens.
   */
  componentOverrides: string;
  /** Unlayered `:root` token overrides for this skin, light palette. */
  tokens: string;
  /**
   * Dark palette, scoped by the block itself (`:root[data-theme="dark"]`).
   * The shell resolves `auto` via `prefers-color-scheme` and sets the
   * attribute, so one explicit selector covers manual and OS dark alike.
   */
  dark?: string;
  /** Unlayered mobile-breakpoint CSS — rides above sure-ui's shared layer. */
  mobile?: string;
}

/** A registered catalog entry: the folder spec plus the shared bindings. */
export interface Skin extends SkinSpec {
  /** sure-ui base theme the component runs are composed over. */
  theme: string;
  /** sure-ui component families (includes the opt-in mail families). */
  components: readonly ComponentName[];
}
