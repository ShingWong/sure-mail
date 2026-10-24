// Reading pane: a sure-ui mail thread. Body text is rendered as text (never
// innerHTML) so message content cannot inject markup into the app.
import { formatFullDate, formatSize, type MessageBody } from "../store/rows.ts";
import { h, replaceChildren } from "./h.ts";

export function renderReading(container: HTMLElement, body: MessageBody | null): void {
  if (body === null) {
    replaceChildren(container, h("div", { class: "sure-mail-app__empty", text: "Select a message to read." }));
    return;
  }
  const thread = h(
    "article",
    { class: "sure-mail-thread", "aria-label": "Message" },
    h(
      "header",
      { class: "sure-mail-thread__header" },
      h("h2", { class: "sure-mail-thread__title", text: body.subject || "(no subject)" }),
      h(
        "div",
        { class: "sure-mail-thread__meta" },
        h("span", { class: "sure-mail-thread__from", text: body.from || "(unknown sender)" }),
        h("span", { class: "sure-mail-thread__date", text: formatFullDate(body.date) }),
      ),
    ),
    h(
      "div",
      { class: "sure-mail-thread__body" },
      h("div", { class: "sure-mail-app__body-text", text: body.bodyText || "(no text body)" }),
    ),
  );
  if (body.attachments.length > 0) {
    thread.append(
      h(
        "div",
        { class: "sure-mail-thread__attachments" },
        ...body.attachments.map((attachment) =>
          h("span", {
            class: "sure-mail-thread__attachment",
            text: `${attachment.filename} (${formatSize(attachment.size)})`,
          }),
        ),
      ),
    );
  }
  replaceChildren(container, thread);
}
