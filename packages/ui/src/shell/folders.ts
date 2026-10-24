// Folder rail: sure-ui mail folder trees, grouped the way the reference
// clients group them — the account's special folders first, everything else
// under a second heading. Selection is `aria-current` + `.is-selected`,
// exactly the contract mail.ts styles; the icon/heading slots are consumer
// chrome the skins re-colour.
import type { FolderRow } from "../store/rows.ts";
import { h, replaceChildren } from "./h.ts";
import { icon, type IconName } from "./icons.ts";

export interface FolderTreeHandlers {
  onSelect(path: string): void;
}

export interface FolderTreeOptions {
  /** Headings for the two groups (account · Local Folders). */
  labels?: [string, string];
}

const SPECIAL: Record<string, { icon: IconName; key: string }> = {
  inbox: { icon: "mail", key: "inbox" },
  sent: { icon: "send", key: "sent" },
  drafts: { icon: "doc", key: "draft" },
  draft: { icon: "doc", key: "draft" },
  junk: { icon: "ban", key: "junk" },
  spam: { icon: "ban", key: "junk" },
  trash: { icon: "trash", key: "trash" },
  deleted: { icon: "trash", key: "trash" },
  deleteditems: { icon: "trash", key: "trash" },
  archive: { icon: "archive", key: "archive" },
};

function folderKind(folder: FolderRow): { icon: IconName; key: string } {
  const name = folder.name.toLowerCase().replace(/[^a-z]/g, "");
  return SPECIAL[name] ?? { icon: "folder", key: "other" };
}

export function renderFolderTree(
  container: HTMLElement,
  folders: FolderRow[],
  selectedPath: string | null,
  handlers: FolderTreeHandlers,
  options: FolderTreeOptions = {},
): void {
  if (folders.length === 0) {
    replaceChildren(container, h("div", { class: "sure-mail-app__empty", text: "No folders yet — run a sync." }));
    return;
  }
  const labels = options.labels ?? ["", "Local Folders"];
  const primary = folders.filter((folder) => folderKind(folder).key !== "other");
  const secondary = folders.filter((folder) => folderKind(folder).key === "other");
  const groups: HTMLElement[] = [];
  if (primary.length > 0) groups.push(treeGroup(primary, labels[0], selectedPath, handlers));
  if (secondary.length > 0) groups.push(treeGroup(secondary, labels[1], selectedPath, handlers));
  replaceChildren(container, ...groups);
}

function treeGroup(
  folders: FolderRow[],
  label: string,
  selectedPath: string | null,
  handlers: FolderTreeHandlers,
): HTMLElement {
  const tree = h("ul", { class: "sure-mail-tree", role: "tree", "aria-label": label || "Folders" });
  for (const folder of folders) {
    const active = folder.path === selectedPath;
    const kind = folderKind(folder);
    const item = h(
      "li",
      {
        class: `sure-mail-tree__item${active ? " is-selected" : ""}`,
        role: "treeitem",
        tabindex: 0,
        "aria-current": active ? "true" : null,
        style: "--mail-tree-depth: 0",
        dataset: { folder: kind.key, path: folder.path },
        onclick: () => handlers.onSelect(folder.path),
        onkeydown: (event: Event) => {
          const key = (event as KeyboardEvent).key;
          if (key === "Enter" || key === " ") {
            event.preventDefault();
            handlers.onSelect(folder.path);
          }
        },
      },
      h("span", { class: "sure-mail-tree__icon", "aria-hidden": "true" }, icon(kind.icon)),
      h("span", { class: "sure-mail-tree__label", text: folder.name }),
    );
    tree.append(item);
  }
  if (label.length === 0) return tree;
  return h("section", { class: "sure-mail-app__rail-group" }, h("p", { class: "sure-mail-app__rail-section", text: label }), tree);
}
