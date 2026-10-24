// h() — the element factory. Plain DOM, no framework: attributes, a small
// set of properties, delegated `on*` handlers, and child nodes. This is the
// stack's CLIENT-TARGET shape ("no framework, no runtime dependency").
export type Child = Node | string | number | null | undefined | false;

export interface ElementProps {
  [key: string]: unknown;
}

export type ElementFactory = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElementProps | null,
  ...children: Child[]
) => HTMLElementTagNameMap[K];

export const h: ElementFactory = (tag, props, ...children) => {
  const el = document.createElement(tag);
  applyProps(el, props ?? {});
  appendChildren(el, children);
  return el;
};

export function applyProps(el: Element, props: ElementProps): void {
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") {
      el.className = String(value);
    } else if (key === "dataset" && value && typeof value === "object") {
      Object.assign((el as HTMLElement).dataset, value as Record<string, string>);
    } else if (key === "style" && typeof value === "string") {
      el.setAttribute("style", value);
    } else if (key === "text") {
      el.textContent = String(value);
    } else if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (isFormControl(el) && key === "value") {
      el.value = String(value);
    } else if (el instanceof HTMLInputElement && key === "checked") {
      el.checked = Boolean(value);
    } else if (value === true) {
      el.setAttribute(key, "");
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

export function appendChildren(el: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === "") continue;
    if (Array.isArray(child)) {
      appendChildren(el, child);
    } else if (child instanceof Node) {
      el.append(child);
    } else {
      el.append(document.createTextNode(String(child)));
    }
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function replaceChildren(el: Element, ...children: Child[]): void {
  clear(el);
  appendChildren(el, children);
}

function isFormControl(el: Element): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}
