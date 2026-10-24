// Message list: a sure-ui mail list. Rows carry the full Track B contract
// (`sure-mail-row` + `--unread`/`--selected`/`--flagged`, the `__check`/
// `__flag`/`__main`/`__time`/`__actions` slots); the stacked (two-line)
// modifier is toggled by the active skin. Only actions backed by a real
// handler are rendered — the skins style the slots, they do not invent them.
import type { ActionSpec } from "./chrome.ts";
import { h, replaceChildren } from "./h.ts";
import { icon } from "./icons.ts";
import { formatDate, isFlagged, isUnread, senderName, type MessageRow } from "../store/rows.ts";
import { clamp, type ColumnState } from "./columns.ts";

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
  /** Adjustable columns (off by default: the skins own the row layout). */
  columns?: ColumnState;
  /** Called when a width changes, so the caller can persist and re-render. */
  onColumns?(state: ColumnState): void;
}

export function renderMessageList(
  container: HTMLElement,
  messages: MessageRow[],
  selectedId: string | null,
  handlers: MessageListHandlers,
  options: MessageListOptions = {},
): void {
  const columns = options.columns;
  const adjustable = columns?.enabled === true;
  if (messages.length === 0) {
    // The column header is about the list's structure, so it stays visible when
    // the folder is empty — otherwise turning columns on in an empty folder
    // looks like the button did nothing.
    const empty = h("div", { class: "sure-mail-app__empty", text: options.empty ?? "No messages." });
    if (!adjustable) {
      replaceChildren(container, empty);
      return;
    }
    const holder = h("ul", { class: "sure-mail-list sure-mail-list--adjustable", style: null });
    replaceChildren(
      container,
      columnHeader(columns, holder, (patch) => options.onColumns?.({ ...columns, ...clampPatch(patch) })),
      empty,
    );
    return;
  }
  const list = h("ul", {
    class:
      `sure-mail-list${options.stacked ? " sure-mail-list--stacked" : ""}` +
      `${adjustable ? " sure-mail-list--adjustable" : ""}`,
    style: adjustable ? `--col-from: ${columns.from}px; --col-date: ${columns.date}px` : null,
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
      h("span", {
        class: "sure-mail-row__sender",
        text: senderName(message.fromaddr),
        ...(adjustable
          ? { style: columns.showFrom ? "flex: 0 0 var(--col-from)" : "display: none" }
          : {}),
      }),
      h(
        "span",
        { class: "sure-mail-row__main" },
        options.showFolder && message.folder
          ? h("span", { class: "sure-mail-app__result-folder", text: `${message.folder} · ` })
          : null,
        h("span", { class: "sure-mail-row__subject", text: message.subject || "(no subject)" }),
      ),
      h("span", {
        class: "sure-mail-row__time",
        text: formatDate(message.internaldate),
        ...(adjustable
          ? { style: columns.showDate ? "flex: 0 0 var(--col-date)" : "display: none" }
          : {}),
      }),
      actionSlot(options.actions?.(message, index) ?? []),
    );
    list.append(row);
  });
  if (!adjustable) {
    replaceChildren(container, list);
    return;
  }
  const commit = (patch: Partial<ColumnState>): void => {
    const next: ColumnState = { ...columns, ...patch };
    next.from = clamp(next.from);
    next.date = clamp(next.date);
    options.onColumns?.(next);
  };
  replaceChildren(container, columnHeader(columns, list, commit), list);
}

/** Clamp only the widths a patch mentions. */
function clampPatch(patch: Partial<ColumnState>): Partial<ColumnState> {
  const out: Partial<ColumnState> = { ...patch };
  if (patch.from !== undefined) out.from = clamp(patch.from);
  if (patch.date !== undefined) out.date = clamp(patch.date);
  return out;
}

/** The column header: labels plus a drag grip per resizable column. */
function columnHeader(
  columns: ColumnState,
  list: HTMLElement,
  commit: (patch: Partial<ColumnState>) => void,
): HTMLElement {
  const grip = (key: "from" | "date"): HTMLElement => {
    const el = h("span", {
      class: "sure-mail-list__grip",
      role: "separator",
      "aria-orientation": "vertical",
      "aria-label": `Resize ${key} column`,
      tabindex: 0,
    });
    const variable = key === "from" ? "--col-from" : "--col-date";
    const start = (event: PointerEvent): void => {
      event.preventDefault();
      const x0 = event.clientX;
      const w0 = columns[key];
      let width = w0;
      el.setPointerCapture(event.pointerId);
      const move = (e: PointerEvent): void => {
        width = clamp(w0 + (e.clientX - x0));
        // Paint only: the rows read the variable, so dragging does not rebuild
        // the list on every pointermove.
        list.style.setProperty(variable, `${width}px`);
        header.style.setProperty("--preview", `${width}px`);
      };
      const up = (): void => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        header.style.removeProperty("--preview");
        commit({ [key]: width } as Partial<ColumnState>);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    };
    el.addEventListener("pointerdown", start);
    // Keyboard: arrows nudge by 8px, so widths are adjustable without a mouse.
    el.addEventListener("keydown", (event: KeyboardEvent) => {
      const step = event.key === "ArrowLeft" ? -8 : event.key === "ArrowRight" ? 8 : 0;
      if (step === 0) return;
      event.preventDefault();
      commit({ [key]: columns[key] + step } as Partial<ColumnState>);
    });
    return el;
  };

  const header = h(
    "div",
    { class: "sure-mail-list__header", "aria-hidden": "true" },
    h("span", { class: "sure-mail-list__head-spacer" }),
    columns.showFrom
      ? h("span", { class: "sure-mail-list__head", style: "flex: 0 0 var(--col-from)", text: "From" })
      : null,
    grip("from"),
    h("span", { class: "sure-mail-list__head sure-mail-list__head--subject", text: "Subject" }),
    columns.showDate
      ? h("span", { class: "sure-mail-list__head", style: "flex: 0 0 var(--col-date)", text: "Date" })
      : null,
    grip("date"),
  );
  header.style.setProperty("--col-from", `${columns.from}px`);
  header.style.setProperty("--col-date", `${columns.date}px`);
  return header;
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
