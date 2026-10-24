// The app shell: a three-pane mail client (folders | list | reading) built
// from h() factories and plain DOM. All data flows through the core via the
// store wrappers in ../store — this class only holds view state (selection,
// search mode, spaces, multi-select) and wires events. M5 adds the structural
// chrome every skin re-paints: the spaces tab bar, the toolbar action strip,
// the list header, the reading-pane toolbar, the status footer and the
// settings dialog with the runtime skin + theme switch.
import type { MailHost } from "@shing.wong/sure-mail-host-web";
import { sendComposed } from "@shing.wong/sure-mail-flows";
import { DEFAULT_SKIN_ID, applySkin, getSkin, type Skin } from "../skin/index.ts";
import { runOp } from "../store/core.ts";
import { toAccount, type AccountRow, type FolderRow, type MessageBody, type MessageRow } from "../store/rows.ts";
import {
  publish,
  accountStore,
  folderStore,
  loadMessageBody,
  messageStore,
  saveDraft,
  searchMessages,
  REGISTRY,
  type CoreEntityStore,
} from "../store/stores.ts";
import { actionBar, avatar, createSettingsDialog, createTabBar, type SettingsDialog, type ThemeChoice } from "./chrome.ts";
import { createComposePanel, type ComposeFields, type ComposePanel } from "./compose.ts";
import { renderFolderTree } from "./folders.ts";
import { h, replaceChildren } from "./h.ts";
import { icon } from "./icons.ts";
import { renderMessageList, scrollSelectedIntoView } from "./list.ts";
import { renderReading } from "./reading.ts";

export interface AccountInput {
  address: string;
  host: string;
  port: number;
  tls: boolean;
  user: string;
  password: string;
  smtpHost?: string;
  smtpPort?: number;
}

export interface MailAppOptions {
  skinId?: string;
  theme?: ThemeChoice;
  /** First-run form prefill (e.g. from `?host=…&port=…` query params). */
  prefill?: Partial<AccountInput>;
}

export type SpaceId = "mail" | "addressbook" | "calendar" | "tasks";

const SPACES: { id: SpaceId; label: string; icon: "mail" | "person" | "calendar" | "tasks" }[] = [
  { id: "mail", label: "Mail", icon: "mail" },
  { id: "addressbook", label: "Address Book", icon: "person" },
  { id: "calendar", label: "Calendar", icon: "calendar" },
  { id: "tasks", label: "Tasks", icon: "tasks" },
];

interface Elements {
  top: HTMLElement;
  rail: HTMLElement;
  railBody: HTMLElement;
  listHead: HTMLElement;
  listBody: HTMLElement;
  readToolbar: HTMLElement;
  readScroll: HTMLElement;
  status: HTMLElement;
  search: HTMLInputElement;
  selection: HTMLElement;
  tabBar: ReturnType<typeof createTabBar>;
  settings: SettingsDialog;
  compose: ComposePanel;
}

export class MailApp {
  readonly host: MailHost;
  private readonly root: HTMLElement;
  private skin: Skin;
  private theme: ThemeChoice;
  private readonly prefill: Partial<AccountInput>;

  private readonly accountsStore: CoreEntityStore<AccountRow>;
  private accountRows: AccountRow[] = [];
  private account: AccountRow | null = null;
  private folders: FolderRow[] = [];
  private selectedFolder: string | null = null;
  private messages: MessageRow[] = [];
  private selectedIndex = -1;
  private readonly selectedIds = new Set<string>();
  private space: SpaceId = "mail";
  private body: MessageBody | null = null;
  private mode: "folder" | "search" = "folder";
  private searchQuery = "";
  private busy = false;
  private readonly els: Elements;

  constructor(host: MailHost, root: HTMLElement, options: MailAppOptions = {}) {
    this.host = host;
    this.root = root;
    this.prefill = options.prefill ?? {};
    this.skin = getSkin(options.skinId ?? DEFAULT_SKIN_ID);
    this.theme = options.theme ?? "auto";
    this.accountsStore = accountStore(host);
    this.els = this.mount();
    this.renderListHead();
    this.renderReadToolbar();
    this.renderReading();
    this.applySkin(this.skin.id);
    this.applyTheme(this.theme);
  }

  // -- lifecycle ------------------------------------------------------------

  async start(): Promise<void> {
    await this.host.storeClient?.ready();
    await this.host.ensureSchema(REGISTRY);
    await this.refreshAccounts();
    this.installKeyboard();
    this.installThemeWatcher();
    if (this.accountRows.length === 0) {
      this.renderFirstRun();
      this.renderStatus("Add an account to begin.");
      return;
    }
    await this.activateAccount(this.accountRows[0]);
  }

  destroy(): void {
    this.host.close();
  }

  // -- public view state (also the browser-test handle) ---------------------

  get skinId(): string {
    return this.skin.id;
  }

  get themeChoice(): ThemeChoice {
    return this.theme;
  }

  get activeSpace(): SpaceId {
    return this.space;
  }

  get accounts(): AccountRow[] {
    return this.accountRows;
  }

  get currentAccount(): AccountRow | null {
    return this.account;
  }

  get folder(): string | null {
    return this.selectedFolder;
  }

  get messageList(): MessageRow[] {
    return this.messages;
  }

  get activeMessage(): MessageRow | null {
    return this.messages[this.selectedIndex] ?? null;
  }

  get reading(): MessageBody | null {
    return this.body;
  }

  get searching(): boolean {
    return this.mode === "search";
  }

  get selectionCount(): number {
    return this.selectedIds.size;
  }

  // -- actions --------------------------------------------------------------

  setSkin(id: string): void {
    this.applySkin(id);
    this.renderMessageList();
  }

  setTheme(theme: ThemeChoice): void {
    this.theme = theme;
    this.applyTheme(theme);
  }

  openSettings(): void {
    this.els.settings.open();
  }

  async addAccount(input: AccountInput): Promise<void> {
    const account: Record<string, unknown> = {
      address: input.address,
      host: input.host,
      port: input.port,
      tls: input.tls,
      user: input.user || input.address,
      password: input.password,
    };
    if (input.smtpHost) account.smtp_host = input.smtpHost;
    if (input.smtpPort) account.smtp_port = input.smtpPort;
    const id = this.host.accountAdd(account);
    if (id <= 0) throw new Error(`account was rejected (${id})`);
    await this.host.flush();
    await this.refreshAccounts();
    const created = this.accountRows.find((a) => a.id === String(id)) ?? this.accountRows[0];
    await this.activateAccount(created);
  }

  async openFolder(path: string): Promise<void> {
    if (!this.account) return;
    this.mode = "folder";
    this.searchQuery = "";
    this.els.search.value = "";
    this.selectedFolder = path;
    this.selectedIds.clear();
    const store = messageStore(this.host, Number(this.account.id), path);
    await store.fetch();
    this.messages = store.items;
    this.selectedIndex = this.messages.length > 0 ? 0 : -1;
    this.renderFolderTree();
    this.renderMessageList();
    await this.openMessage(this.selectedIndex);
  }

  async runSearch(query: string): Promise<void> {
    if (!this.account) return;
    this.searchQuery = query.trim();
    if (this.searchQuery.length === 0) {
      if (this.selectedFolder) await this.openFolder(this.selectedFolder);
      return;
    }
    this.mode = "search";
    this.messages = await searchMessages(this.host, Number(this.account.id), this.searchQuery);
    this.selectedIndex = this.messages.length > 0 ? 0 : -1;
    this.renderFolderTree();
    this.renderMessageList();
    await this.openMessage(this.selectedIndex);
    this.renderStatus(`${this.messages.length} result${this.messages.length === 1 ? "" : "s"} for “${this.searchQuery}”`);
  }

  async sync(): Promise<void> {
    const account = this.account;
    if (!account) return;
    const folder = this.selectedFolder;
    this.setBusy(true, folder ? `Syncing ${folder}…` : "Syncing…");
    try {
      const args = folder ? { account: Number(account.id), folder } : { account: Number(account.id) };
      // A full sync downloads bodies for every folder; a minute is not enough
      // for a real mailbox, and stopping the wait does not stop the walk — it
      // just hides the result. Ten minutes, and the folder list is refreshed
      // independently on activation either way.
      await runOp(this.host, "imap.sync", args, 600000);
      await this.activateAccount(account);
      this.renderStatus(folder ? `Synced ${folder}` : "Sync complete");
    } catch (err) {
      this.renderStatus(`Sync failed: ${message(err)}`);
    } finally {
      this.setBusy(false);
    }
  }

  setSpace(id: SpaceId): void {
    this.space = id;
    this.els.tabBar.setActive(id);
    this.root.dataset.space = id;
    if (id === "mail") {
      this.renderFolderTree();
      this.renderMessageList();
      this.renderReading();
      return;
    }
    const label = SPACES.find((s) => s.id === id)?.label ?? id;
    this.selectedFolder = null;
    this.messages = [];
    this.body = null;
    replaceChildren(this.els.railBody, h("div", { class: "sure-mail-app__empty", text: "Not available in this build." }));
    replaceChildren(this.els.listBody, h("div", { class: "sure-mail-app__empty", text: `${label} is not part of this build.` }));
    replaceChildren(this.els.readScroll, h("div", { class: "sure-mail-app__empty", text: "" }));
    this.renderStatus(`${label} — not part of this build`);
  }

  openCompose(prefill?: Partial<ComposeFields>): void {
    this.els.compose.open(prefill);
  }

  openReply(kind: "reply" | "replyAll" | "forward", message: MessageRow | null = this.activeMessage): void {
    if (!message) return;
    if (kind === "forward") {
      this.openCompose({ subject: `Fwd: ${message.subject}`, body: "" });
      return;
    }
    this.openCompose({
      to: message.fromaddr,
      subject: /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`,
      body: "",
    });
  }

  async openMessage(index: number): Promise<void> {
    this.selectedIndex = index;
    const active = this.activeMessage;
    this.renderMessageList();
    scrollSelectedIntoView(this.els.listBody);
    if (!active || !this.account) {
      this.body = null;
      this.renderReading();
      return;
    }
    try {
      this.body = await loadMessageBody(this.host, Number(this.account.id), active.folder, active.uid);
    } catch (err) {
      this.body = null;
      this.renderStatus(`Could not load message: ${message(err)}`);
    }
    this.renderReading();
  }

  toggleSelect(id: string, checked: boolean): void {
    if (checked) this.selectedIds.add(id);
    else this.selectedIds.delete(id);
    this.renderListHead();
  }

  // -- account boot ---------------------------------------------------------

  private async refreshAccounts(): Promise<void> {
    const opId = this.host.startOp("store.query", { store: REGISTRY, query: "accounts" });
    if (opId < 0) throw new Error("could not read the account registry");
    const status = await this.host.drive(opId, { timeoutMs: 15000 });
    if (status.state !== "done") throw new Error("could not read the account registry");
    const rows = ((status.result as { rows?: Record<string, unknown>[] }).rows ?? []);
    // Seed the core's account state exactly like the CLI does on boot.
    this.host.init({ accounts: rows });
    this.accountRows = rows.map(toAccount);
    publish(this.accountsStore, this.accountRows);
  }

  private async activateAccount(account: AccountRow): Promise<void> {
    this.account = account;
    await this.host.ensureSchema(`account:${account.id}`);
    const store = folderStore(this.host, Number(account.id));
    await store.fetch();

    // Ask the server for the folder list, rather than waiting for a sync to
    // walk into each folder. Folders used to appear only as a side effect of
    // imap.sync, so a first run — or a sync that stopped early, or one the UI
    // stopped waiting for — left a partial rail: INBOX, Sent and Trash missing
    // because the walk had not reached them yet. A LIST is one round trip and
    // cheap; keep the stored list when it fails (offline).
    if (this.host.net.connected) {
      try {
        await runOp(this.host, "imap.folders", { account: Number(account.id) }, 30000);
        await store.fetch();
      } catch {
        // Offline or the server refused LIST: what is stored is still true.
      }
    }
    this.folders = store.items;
    const inbox = this.folders.find((f) => /^inbox$/i.test(f.name) || /^inbox$/i.test(f.path)) ?? this.folders[0];
    if (inbox) {
      await this.openFolder(inbox.path);
    } else {
      this.selectedFolder = null;
      this.messages = [];
      this.renderFolderTree();
      this.renderMessageList();
      this.renderReading();
    }
    const initials = (this.els.top.querySelector(".sure-mail-app__avatar") as HTMLElement | null);
    if (initials) initials.replaceWith(avatar(account.address));
    this.renderStatus(this.folders.length === 0 ? "No folders yet — run a sync" : undefined);
  }

  // -- DOM ------------------------------------------------------------------

  private mount(): Elements {
    this.root.classList.add("sure-mail-app");
    this.root.dataset.skin = this.skin.id;
    this.root.dataset.space = "mail";

    const search = h("input", {
      class: "sure-mail-search__input",
      type: "search",
      placeholder: "Search mail  (/)",
      "aria-label": "Search mail",
    });

    const settings = createSettingsDialog({
      onSkin: (id) => this.setSkin(id),
      onTheme: (theme) => this.setTheme(theme),
    });
    const avatarSlot = h("span", { class: "sure-mail-app__avatar", "aria-hidden": "true" });

    const top = h(
      "header",
      { class: "sure-mail-app__top" },
      h(
        "span",
        { class: "sure-mail-app__lights", "aria-hidden": "true" },
        h("span", { class: "sure-mail-app__light sure-mail-app__light--close" }),
        h("span", { class: "sure-mail-app__light sure-mail-app__light--min" }),
        h("span", { class: "sure-mail-app__light sure-mail-app__light--max" }),
      ),
      h("span", { class: "sure-mail-app__brand", text: "sure-mail" }),
      h(
        "button",
        { type: "button", class: "btn-primary sure-mail-app__new", title: "Compose (c)", onclick: () => this.openCompose() },
        icon("pencil"),
        h("span", { text: "Compose" }),
      ),
      h(
        "div",
        { class: "sure-mail-app__actions" },
        h(
          "button",
          { type: "button", class: "sure-mail-action sure-mail-app__sync", title: "Sync (r)", "aria-label": "Sync", onclick: () => void this.sync() },
          icon("refresh"),
        ),
      ),
      h(
        "div",
        { class: "sure-mail-app__search sure-mail-search" },
        h("span", { class: "sure-mail-app__search-icon", "aria-hidden": "true" }, icon("search")),
        search,
      ),
      h(
        "div",
        { class: "sure-mail-app__end" },
        h(
          "button",
          { type: "button", class: "sure-mail-action sure-mail-app__settings-btn", title: "Settings", "aria-label": "Settings", onclick: () => this.openSettings() },
          icon("settings"),
        ),
        avatarSlot,
      ),
    );

    const tabBar = createTabBar(
      SPACES.map((s) => ({ id: s.id, label: s.label, icon: s.icon, closable: s.id !== "mail" })),
      (id) => this.setSpace(id as SpaceId),
    );
    tabBar.setActive("mail");

    const compose = createComposePanel({
      onSave: (fields) => this.saveDraft(fields),
      onSend: (fields) => this.sendMessage(fields),
    });

    const railNew = h(
      "button",
      { type: "button", class: "btn-primary sure-mail-app__rail-new", title: "Compose (c)", onclick: () => this.openCompose() },
      icon("pencil"),
      h("span", { text: "Compose" }),
    );
    const railBody = h("div", { class: "sure-mail-app__rail-body" });
    const rail = h("aside", { class: "sure-mail-app__rail", "aria-label": "Folders" }, railNew, railBody);
    const listHead = h("div", { class: "sure-mail-app__list-head" });
    const listBody = h("div", { class: "sure-mail-app__list-body" });
    const list = h("section", { class: "sure-mail-app__list", "aria-label": "Messages" }, listHead, listBody);
    const readToolbar = h("div", { class: "sure-mail-app__read-toolbar" });
    const readScroll = h("div", { class: "sure-mail-app__read-scroll" });
    const reading = h("section", { class: "sure-mail-app__reading", "aria-label": "Reading pane" }, readToolbar, readScroll);
    const status = h("footer", { class: "sure-mail-app__status" });

    replaceChildren(this.root, tabBar.el, top, rail, list, reading, status, compose.el, settings.el);
    return { top, rail, railBody, listHead, listBody, readToolbar, readScroll, status, search, selection: h("span"), tabBar, settings, compose };
  }

  private renderFirstRun(): void {
    const prefill = this.prefill;
    const field = (label: string, key: keyof AccountInput, type = "text", value = ""): HTMLElement =>
      h(
        "label",
        { class: "sure-mail-compose__address" },
        h("span", { class: "sure-mail-compose__label", text: label }),
        h("div", { class: "sure-mail-compose__chips" },
          h("input", {
            class: "sure-mail-compose__input",
            type,
            id: `account-${key}`,
            value,
            // The first field is the account's address, not a display name: it
            // was labelled "Name" while being type=email, so typing a name got
            // the browser's "missing an @" bubble and the form never submitted.
            required: key === "address" || key === "host",
            ...(key === "address"
              ? { placeholder: "you@example.com", autocomplete: "username" }
              : {}),
            ...(key === "password" ? { autocomplete: "current-password" } : {}),
          })),
      );
    const tls = h("input", { type: "checkbox", id: "account-tls", checked: prefill.tls ?? false });
    const status = h("span", { class: "sure-mail-compose__status" });
    const form = h(
      "form",
      {
        class: "sure-mail-compose",
        "aria-label": "Add an account",
        onsubmit: (event: Event) => {
          event.preventDefault();
          void submit();
        },
      },
      h("div", { class: "sure-mail-compose__subject" }, h("strong", { text: "Add an account" })),
      // A static deploy has a store but no mail host. Saying so here, rather
      // than only in the status bar, is the difference between "broken" and
      // "not connected yet".
      ...(this.host.net.connected
        ? []
        : [
            h("p", {
              class: "sure-mail-compose__hint",
              text:
                "No mail host is attached to this page. You can add an account and keep it locally, " +
                "but fetching mail needs the local relay running on this machine.",
            }),
          ]),
      field("Email address", "address", "email", prefill.address ?? ""),
      field("IMAP host", "host", "text", prefill.host ?? ""),
      field("Port", "port", "number", String(prefill.port ?? 993)),
      field("User", "user", "text", prefill.user ?? ""),
      field("Password", "password", "password", prefill.password ?? ""),
      field("SMTP host", "smtpHost", "text", prefill.smtpHost ?? ""),
      field("SMTP port", "smtpPort", "number", String(prefill.smtpPort ?? 465)),
      h("label", { class: "sure-mail-compose__address" },
        h("span", { class: "sure-mail-compose__label", text: "TLS" }),
        tls),
      h("footer", { class: "sure-mail-compose__footer" }, status,
        h("div", { class: "sure-mail-compose__actions" },
          h("button", { type: "submit", class: "btn-primary" }, "Add account"))),
    );

    const read = (key: string): string => {
      const el = document.getElementById(`account-${key}`);
      return el instanceof HTMLInputElement ? el.value.trim() : "";
    };
    const submit = async (): Promise<void> => {
      status.textContent = "Adding…";
      try {
        const smtpHost = read("smtpHost");
        const smtpPort = Number(read("smtpPort")) || 0;
        await this.addAccount({
          address: read("address"),
          host: read("host"),
          port: Number(read("port")) || 993,
          tls: tls.checked,
          user: read("user"),
          password: read("password"),
          ...(smtpHost ? { smtpHost } : {}),
          ...(smtpPort ? { smtpPort } : {}),
        });
        status.textContent = "Account added.";
      } catch (err) {
        status.textContent = message(err);
      }
    };

    replaceChildren(this.els.railBody, h("div", { class: "sure-mail-app__empty", text: "No account yet." }));
    replaceChildren(this.els.listBody, h("div", { class: "sure-mail-app__empty", text: "" }));
    replaceChildren(this.els.readScroll, h("div", { class: "sure-mail-app__firstrun" }, form));
  }

  private renderFolderTree(): void {
    if (!this.account) {
      replaceChildren(this.els.railBody, h("div", { class: "sure-mail-app__empty", text: "No account." }));
      return;
    }
    const header = h(
      "div",
      { class: "sure-mail-app__account" },
      h("span", { class: "sure-mail-app__account-name", text: this.account.address }),
      h("span", { text: ` · ${this.account.host}` }),
    );
    const tree = h("div");
    renderFolderTree(tree, this.folders, this.mode === "search" ? null : this.selectedFolder, {
      onSelect: (path) => void this.openFolder(path),
    }, { labels: [this.account.address, "Local Folders"] });
    replaceChildren(this.els.railBody, header, tree);
  }

  private renderListHead(): void {
    const tabs = h(
      "div",
      { class: "sure-mail-app__list-tabs", role: "tablist", "aria-label": "Focus" },
      h("button", { type: "button", class: "sure-mail-search__chip is-active", "aria-pressed": "true" }, "Focused"),
      h("button", { type: "button", class: "sure-mail-search__chip", "aria-pressed": "false" }, "Other"),
    );
    const sort = h("span", { class: "sure-mail-app__sort", text: "Sort: Date" });
    this.els.selection.textContent = this.selectionLabel();
    this.els.selection.className = "sure-mail-app__selection";
    replaceChildren(this.els.listHead, tabs, sort, this.els.selection);
  }

  private selectionLabel(): string {
    const count = this.selectedIds.size;
    const shown = this.messages.length;
    if (count > 0) return `${count} selected · ${shown} shown`;
    return `${shown} shown`;
  }

  private renderReadToolbar(): void {
    replaceChildren(
      this.els.readToolbar,
      actionBar("Message actions", [
        { icon: "reply", title: "Reply", onClick: () => this.openReply("reply") },
        { icon: "replyAll", title: "Reply to all", onClick: () => this.openReply("replyAll") },
        { icon: "forward", title: "Forward", onClick: () => this.openReply("forward") },
      ]),
    );
  }

  private renderMessageList(): void {
    if (this.space !== "mail") return;
    const handlers = {
      onSelect: (index: number): void => void this.openMessage(index),
      onOpen: (index: number): void => void this.openMessage(index),
    };
    const options = {
      stacked: this.skin.stackedList,
      selectable: true,
      selectedIds: this.selectedIds,
      onToggleSelect: (id: string, checked: boolean): void => this.toggleSelect(id, checked),
      actions: (message: MessageRow): { icon: "reply" | "forward"; title: string; onClick: () => void }[] => [
        { icon: "reply", title: "Reply", onClick: () => this.openReply("reply", message) },
        { icon: "forward", title: "Forward", onClick: () => this.openReply("forward", message) },
      ],
    };
    if (this.mode === "search") {
      renderMessageList(this.els.listBody, this.messages, this.activeMessage?.id ?? null, handlers, {
        ...options,
        showFolder: true,
        empty: `No messages match “${this.searchQuery}”.`,
      });
    } else {
      renderMessageList(this.els.listBody, this.messages, this.activeMessage?.id ?? null, handlers, {
        ...options,
        empty: "No messages in this folder.",
      });
    }
    this.renderListHead();
  }

  private renderReading(): void {
    this.els.readToolbar.querySelectorAll("button").forEach((button) => {
      button.disabled = this.body === null;
    });
    renderReading(this.els.readScroll, this.body);
  }

  private renderStatus(text?: string): void {
    const parts: string[] = [];
    if (text) parts.push(text);
    if (this.account) parts.push(this.account.address);
    parts.push(this.host.net.connected ? "relay online" : "relay offline — local store only");
    if (this.busy) parts.push("working…");
    replaceChildren(this.els.status, h("span", { class: "sure-mail-app__keyhint", text: parts.join("  ·  ") }));
  }

  private setBusy(busy: boolean, note?: string): void {
    this.busy = busy;
    this.renderStatus(note);
  }

  // -- compose --------------------------------------------------------------

  private async saveDraft(fields: ComposeFields): Promise<string> {
    if (!this.account) return "No account.";
    const id = await saveDraft(this.host, {
      account: Number(this.account.id),
      subject: fields.subject,
      fromaddr: this.account.address,
      toaddrs: JSON.stringify(addresses(fields.to)),
      ccaddrs: JSON.stringify(addresses(fields.cc)),
      body_text: fields.body,
      now: Date.now(),
    });
    return `Draft ${id} saved`;
  }

  private async sendMessage(fields: ComposeFields): Promise<string> {
    if (!this.account) return "No account.";
    const to = addresses(fields.to);
    if (to.length === 0) throw new Error("Add at least one recipient.");
    const cc = addresses(fields.cc);
    const message = {
      from: { address: this.account.address },
      to,
      cc,
      subject: fields.subject,
      text: fields.body,
    };
    // One shared flow with the CLI (D15): send, file the copy to Sent, audit
    // the send. The flow is best-effort on the Sent append, so a filed copy is
    // reported but never required for the send to succeed.
    const outcome = await sendComposed(
      (kind, args, timeoutMs) => runOp(this.host, kind, args, timeoutMs ?? 120000),
      { id: Number(this.account.id), address: this.account.address },
      message,
    );
    return outcome.appended
      ? `Sent — ${outcome.messageId}`
      : `Sent — ${outcome.messageId} (not filed to Sent: ${outcome.appendNote})`;
  }

  // -- keyboard -------------------------------------------------------------

  private installKeyboard(): void {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
      if (event.key === "Escape") {
        if (this.els.settings.isOpen()) {
          this.els.settings.close();
          event.preventDefault();
        } else if (this.els.compose.isOpen()) {
          this.els.compose.close();
          event.preventDefault();
        }
        return;
      }
      if (typing) {
        if (event.key === "Enter" && target === this.els.search) {
          void this.runSearch(this.els.search.value);
          event.preventDefault();
        }
        return;
      }
      switch (event.key) {
        case "/":
          this.els.search.focus();
          event.preventDefault();
          break;
        case "c":
          this.openCompose();
          event.preventDefault();
          break;
        case ",":
          this.openSettings();
          event.preventDefault();
          break;
        case "j":
        case "ArrowDown":
          this.moveSelection(1);
          event.preventDefault();
          break;
        case "k":
        case "ArrowUp":
          this.moveSelection(-1);
          event.preventDefault();
          break;
        case "Enter":
        case "o":
          if (this.selectedIndex >= 0) void this.openMessage(this.selectedIndex);
          event.preventDefault();
          break;
        case "r":
          void this.sync();
          event.preventDefault();
          break;
        default:
          break;
      }
    };
    document.addEventListener("keydown", onKey);
    this.els.search.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        void this.runSearch(this.els.search.value);
        event.preventDefault();
      } else if (event.key === "Escape") {
        this.els.search.value = "";
        void this.runSearch("");
      }
    });
  }

  private moveSelection(delta: number): void {
    if (this.messages.length === 0) return;
    const next = Math.min(this.messages.length - 1, Math.max(0, this.selectedIndex + delta));
    if (next !== this.selectedIndex) void this.openMessage(next);
  }

  private applySkin(id: string): void {
    this.skin = getSkin(id);
    applySkin(document, this.skin);
    this.root.dataset.skin = this.skin.id;
    this.els.settings.setSkin(this.skin.id);
    try {
      localStorage.setItem("sure-mail.skin", this.skin.id);
    } catch {
      // localStorage may be unavailable (private mode); the skin still applies.
    }
    this.renderMessageList();
  }

  private applyTheme(theme: ThemeChoice): void {
    this.els.settings.setTheme(theme);
    this.setResolvedTheme(resolveTheme(theme));
    try {
      localStorage.setItem("sure-mail.theme", theme);
    } catch {
      // localStorage may be unavailable (private mode); the theme still applies.
    }
  }

  private setResolvedTheme(resolved: "light" | "dark"): void {
    document.documentElement.dataset.theme = resolved;
  }

  private installThemeWatcher(): void {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener?.("change", () => {
      if (this.theme === "auto") this.setResolvedTheme(resolveTheme("auto"));
    });
  }
}

function resolveTheme(theme: ThemeChoice): "light" | "dark" {
  if (theme === "light" || theme === "dark") return theme;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function addresses(value: string): { address: string }[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((address) => ({ address }));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
