// Shared chrome builders: the pieces every skin's structural CSS re-skins —
// the toolbar action strip, the Thunderbird-style tab bar and the settings
// dialog that carries the M5 runtime switch. One markup, four chromes.
import { SKINS } from "../skin/index.ts";
import { h } from "./h.ts";
import { icon, type IconName } from "./icons.ts";

export interface ActionSpec {
  icon: IconName;
  title: string;
  onClick: () => void;
}

/** One icon button in a toolbar strip. */
export function actionButton({ icon: name, title, onClick }: ActionSpec): HTMLButtonElement {
  return h(
    "button",
    { type: "button", class: `sure-mail-action sure-mail-action--${name}`, title, "aria-label": title, onclick: onClick },
    icon(name),
  );
}

/** A `role="toolbar"` strip of icon buttons. */
export function actionBar(label: string, actions: ActionSpec[]): HTMLElement {
  return h(
    "div",
    { class: "sure-mail-action-bar", role: "toolbar", "aria-label": label },
    ...actions.map(actionButton),
  );
}

export interface TabSpec {
  id: string;
  label: string;
  icon: IconName;
  /** Thunderbird puts a close ✕ on every tab but the active one. */
  closable: boolean;
}

export interface TabBar {
  el: HTMLElement;
  setActive(id: string): void;
}

/** The spaces tab bar above the panes (Thunderbird's signature chrome). */
export function createTabBar(tabs: TabSpec[], onSelect: (id: string) => void): TabBar {
  const el = h("nav", { class: "sure-mail-app__tabbar", role: "tablist", "aria-label": "Spaces" });
  const buttons = new Map<string, HTMLButtonElement>();
  for (const tab of tabs) {
    const button = h(
      "button",
      {
        type: "button",
        class: "sure-mail-search__chip sure-mail-app__tab",
        role: "tab",
        "aria-selected": "false",
        onclick: () => onSelect(tab.id),
      },
      h("span", { class: "sure-mail-app__tab-line", "aria-hidden": "true" }),
      h("span", { class: "sure-mail-app__tab-icon", "aria-hidden": "true" }, icon(tab.icon)),
      h("span", { class: "sure-mail-app__tab-label", text: tab.label }),
      tab.closable ? h("span", { class: "sure-mail-app__tab-close", "aria-hidden": "true" }, "✕") : null,
    );
    buttons.set(tab.id, button);
    el.append(button);
  }
  const setActive = (id: string): void => {
    for (const [tabId, button] of buttons) {
      const active = tabId === id;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }
  };
  return { el, setActive };
}

export interface SettingsHandlers {
  onSkin(id: string): void;
  onTheme(theme: ThemeChoice): void;
}

export type ThemeChoice = "light" | "dark" | "auto";

export interface SettingsDialog {
  el: HTMLElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
  setSkin(id: string): void;
  setTheme(theme: ThemeChoice): void;
}

/** The settings dialog: the M5 runtime skin + theme switcher. */
export function createSettingsDialog(handlers: SettingsHandlers): SettingsDialog {
  const skinSelect = h("select", { "aria-label": "Skin" });
  for (const skin of SKINS) skinSelect.append(h("option", { value: skin.id }, skin.name));
  skinSelect.onchange = () => handlers.onSkin(skinSelect.value);

  const themeSelect = h("select", { "aria-label": "Theme" });
  for (const theme of ["auto", "light", "dark"] as const) themeSelect.append(h("option", { value: theme }, theme));
  themeSelect.onchange = () => handlers.onTheme(themeSelect.value as ThemeChoice);

  const overlay = h(
    "div",
    {
      class: "sure-mail-app__settings",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Settings",
      hidden: true,
      onclick: (event: Event) => {
        if (event.target === overlay) close();
      },
    },
    h(
      "div",
      { class: "sure-mail-app__settings-card" },
      h("h2", { text: "Settings" }),
      h("label", { class: "sure-mail-app__settings-row" }, h("span", { text: "Skin" }), skinSelect),
      h("label", { class: "sure-mail-app__settings-row" }, h("span", { text: "Theme" }), themeSelect),
      h(
        "div",
        { class: "sure-mail-app__settings-row sure-mail-app__settings-actions" },
        h("button", { type: "button", class: "btn-secondary", onclick: () => close() }, "Close"),
      ),
    ),
  );

  function open(): void {
    overlay.hidden = false;
    skinSelect.focus();
  }
  function close(): void {
    overlay.hidden = true;
  }
  return {
    el: overlay,
    open,
    close,
    isOpen: () => !overlay.hidden,
    setSkin: (id) => {
      skinSelect.value = id;
    },
    setTheme: (theme) => {
      themeSelect.value = theme;
    },
  };
}

/** The avatar bubble used by Gmail and Outlook chrome. */
export function avatar(address: string): HTMLElement {
  const initials = address
    .split(/[@.\s]+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";
  return h("span", { class: "sure-mail-app__avatar", title: address, text: initials });
}
