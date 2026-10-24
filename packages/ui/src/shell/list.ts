// Message list: a sure-ui mail list. Rows carry the full Track B contract
// (`sure-mail-row` + `--unread`/`--selected`/`--flagged`, the `__check`/
// `__flag`/`__main`/`__time`/`__actions` slots); the stacked (two-line)
// modifier is toggled by the active skin. Only actions backed by a real
// handler are rendered — the skins style the slots, they do not invent them.
import type { ActionSpec } from "./chrome.ts";
import { h, replaceChildren } from "./h.ts";
import { icon } from "./icons.ts";
import { formatDate, isFlagged, isUnread, senderName, type MessageRow } from "../store/rows.ts";

export interface MessageListHandlers {
  onSelect(index: number): void;
  onOpen(index: number): void;
}

export interface MessageListOptions {
  /** Two-line rows (the Outlook Online arrangement). */
  stacked?: boolean;
  /** Show the source folder (search results span folders). */
  showFolder?: boolean;
  empty?: string;
  /** Multi-select checkboxes (the Gmail/TB list toolbar reads the count). */
  selectable?: boolean;
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?(id: string, checked: boolean): void;
  /** Per-row actions revealed on hover (reply/forward — real compose ops). */
  actions?(message: MessageRow, index: number): ActionSpec[];
}

export function renderMessageList(
  container: HTMLElement,
  messages: MessageRow[],
  selectedId: string | null,
  handlers: MessageListHandlers,
  options: MessageListOptions = {},
): void {
  if (messages.length === 0) {
    replaceChildren(container, h("div", { class: "sure-mail-app__empty", text: options.empty ?? "No messages." }));
    return;
  }
  const list = h("ul", {
    class: `sure-mail-list${options.stacked ? " sure-mail-list--stacked" : ""}`,
    role: "listbox",
    "aria-label": "Messages",
    tabindex: 0,
  });
  messages.forEach((message, index) => {
    const unread = isUnread(message.flags);
    const flagged = isFlagged(message.flags);
    const selected = message.id === selectedId;
    const checked = options.selectedIds?.has(message.id) ?? false;
    const row = h(
      "li",
      {
        class:
          `sure-mail-row${unread ? " sure-mail-row--unread" : ""}` +
          `${selected ? " sure-mail-row--selected" : ""}` +
          `${flagged ? " sure-mail-row--flagged" : ""}`,
        role: "option",
        "aria-selected": selected ? "true" : "false",
        tabindex: -1,
        dataset: { index: String(index), uid: String(message.uid), folder: message.folder },
        onclick: () => handlers.onSelect(index),
        ondblclick: () => handlers.onOpen(index),
      },
      checkSlot(checked, options, message),
      flagged
        ? h("span", { class: "sure-mail-row__flag", role: "img", "aria-label": "Flagged" }, icon("flag"))
        : h("span", { class: "sure-mail-row__flag", "aria-hidden": "true" }, icon("flag")),
      h("span", { class: "sure-mail-row__sender", text: senderName(message.fromaddr) }),
      h(
        "span",
        { class: "sure-mail-row__main" },
        options.showFolder && message.folder
          ? h("span", { class: "sure-mail-app__result-folder", text: `${message.folder} · ` })
          : null,
        h("span", { class: "sure-mail-row__subject", text: message.subject || "(no subject)" }),
      ),
      h("span", { class: "sure-mail-row__time", text: formatDate(message.internaldate) }),
      actionSlot(options.actions?.(message, index) ?? []),
    );
    list.append(row);
  });
  replaceChildren(container, list);
}

function checkSlot(
  checked: boolean,
  options: MessageListOptions,
  message: MessageRow,
): HTMLElement {
  const dot = h("span", { class: "sure-mail-app__unread-dot", "aria-hidden": "true" });
  if (!options.selectable) {
    return h("span", { class: "sure-mail-row__check" }, dot);
  }
  const box = h("input", {
    type: "checkbox",
    "aria-label": `Select: ${message.subject || "(no subject)"}`,
    onchange: (event: Event) => {
      event.stopPropagation();
      options.onToggleSelect?.(message.id, (event.target as HTMLInputElement).checked);
    },
  });
  box.checked = checked;
  box.onclick = (event: Event) => event.stopPropagation();
  return h("span", { class: "sure-mail-row__check" }, dot, box);
}

function actionSlot(actions: ActionSpec[]): HTMLElement {
  return h(
    "span",
    { class: "sure-mail-row__actions" },
    ...actions.map(({ icon: name, title, onClick }) =>
      h(
        "button",
        {
          type: "button",
          class: `sure-mail-action sure-mail-action--${name}`,
          title,
          "aria-label": title,
          onclick: (event: Event) => {
            event.stopPropagation();
            onClick();
          },
        },
        icon(name),
      ),
    ),
  );
}

export function scrollSelectedIntoView(container: HTMLElement): void {
  const selected = container.querySelector(".sure-mail-row--selected");
  if (selected instanceof HTMLElement) selected.scrollIntoView({ block: "nearest" });
}
