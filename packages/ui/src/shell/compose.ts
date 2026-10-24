// Compose window: a sure-ui mail compose panel mounted as a floating overlay.
// Pure view + local state; saving/sending is delegated to the app, which runs
// the core ops (draft_save / mime.build + smtp.send).
import { h } from "./h.ts";

export interface ComposeFields {
  to: string;
  cc: string;
  subject: string;
  body: string;
}

export interface ComposeHandlers {
  onSave(fields: ComposeFields): Promise<string>;
  onSend(fields: ComposeFields): Promise<string>;
}

export interface ComposePanel {
  el: HTMLElement;
  open(prefill?: Partial<ComposeFields>): void;
  close(): void;
  isOpen(): boolean;
}

export function createComposePanel(handlers: ComposeHandlers): ComposePanel {
  const to = h("input", { class: "sure-mail-compose__input", type: "email", id: "compose-to", placeholder: "recipient@example.com", autocomplete: "off" });
  const cc = h("input", { class: "sure-mail-compose__input", type: "email", id: "compose-cc", placeholder: "cc@example.com", autocomplete: "off" });
  const subject = h("input", { type: "text", id: "compose-subject", placeholder: "Subject" });
  const body = h("textarea", { class: "sure-mail-compose__body", id: "compose-body", placeholder: "Write your message…" });
  const status = h("span", { class: "sure-mail-compose__status" });

  const overlay = h(
    "div",
    {
      class: "sure-mail-app__compose",
      hidden: true,
      onclick: (event: Event) => {
        if (event.target === overlay) close();
      },
    },
    h(
      "form",
      {
        class: "sure-mail-compose",
        "aria-label": "Compose message",
        onsubmit: (event: Event) => event.preventDefault(),
      },
      addressRow("To", to),
      addressRow("Cc", cc),
      h("div", { class: "sure-mail-compose__subject" }, subject),
      body,
      h(
        "footer",
        { class: "sure-mail-compose__footer" },
        status,
        h(
          "div",
          { class: "sure-mail-compose__actions" },
          h("button", { type: "button", class: "btn-secondary", onclick: () => void save() }, "Save draft"),
          h("button", { type: "button", class: "btn-primary", onclick: () => void send() }, "Send"),
          h("button", { type: "button", class: "btn-secondary", title: "Close (Esc)", onclick: close }, "Close"),
        ),
      ),
    ),
  );

  function read(): ComposeFields {
    return { to: to.value.trim(), cc: cc.value.trim(), subject: subject.value.trim(), body: body.value };
  }

  function open(prefill: Partial<ComposeFields> = {}): void {
    to.value = prefill.to ?? "";
    cc.value = prefill.cc ?? "";
    subject.value = prefill.subject ?? "";
    body.value = prefill.body ?? "";
    status.textContent = "";
    overlay.hidden = false;
    to.focus();
  }

  function close(): void {
    overlay.hidden = true;
  }

  async function save(): Promise<void> {
    status.textContent = "Saving…";
    try {
      status.textContent = await handlers.onSave(read());
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : "Save failed";
    }
  }

  async function send(): Promise<void> {
    status.textContent = "Sending…";
    try {
      status.textContent = await handlers.onSend(read());
      close();
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : "Send failed";
    }
  }

  return { el: overlay, open, close, isOpen: () => !overlay.hidden };
}

function addressRow(label: string, input: HTMLInputElement): HTMLElement {
  return h(
    "div",
    { class: "sure-mail-compose__address" },
    h("span", { class: "sure-mail-compose__label", text: label }),
    h("div", { class: "sure-mail-compose__chips" }, input),
  );
}
