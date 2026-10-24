// Consumer-supplied SVG icons. sure-ui ships no icon set (its action buttons
// size whatever svg you give them and colour it from `currentColor`), so the
// shell owns its glyphs — sourced from the same reference compositions the
// skins port. Every icon is a 24×24 stroke path rendered inline; no sprite,
// no innerHTML, no user data.
const SVG_NS = "http://www.w3.org/2000/svg";

const ICONS: Record<string, readonly string[]> = {
  mail: ["M3.5 5.5h17v13h-17z", "M3.5 7l8.5 6 8.5-6"],
  person: ["M12 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z", "M5 19.5a7 7 0 0 1 14 0"],
  calendar: ["M3.5 5.5h17v14h-17z", "M3.5 10h17M8.5 3.5v4M15.5 3.5v4"],
  tasks: ["M4.5 4.5h15v15h-15z", "M8.5 12.2l2.6 2.6 4.6-5.2"],
  send: ["M20.5 4L3.5 11l7 2.8L13.5 20z", "M10.5 13.8L20.5 4"],
  doc: ["M7 3.5h7l4.5 4.5v12H7z", "M14 3.5V8h4.5"],
  ban: ["M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "M6.5 6.5l11 11"],
  trash: ["M4.5 7h15", "M9.5 7V5.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7", "M6.5 7l.9 12a1 1 0 0 0 1 .9h7.2a1 1 0 0 0 1-.9L17.5 7"],
  folder: ["M3.5 6.5a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-14a1 1 0 0 1-1-1z"],
  archive: ["M3.5 4.5h17v4.5h-17z", "M5.5 9v9.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9", "M10 13h4"],
  flag: ["M6.5 20.5V4", "M6.5 4.8h10.8l-2.4 4.2 2.4 4.2H6.5"],
  mark: ["M4 6.5h9M4 12h9M4 17.5h5", "M15 16.2l2.2 2.2 3.8-4.4"],
  reply: ["M9 6L4 11l5 5", "M4 11h9.5A5.5 5.5 0 0 1 19 16.5V18"],
  replyAll: ["M12.5 6L7.5 11l5 5", "M8.5 6L3.5 11l5 5", "M4 11h9.5A5.5 5.5 0 0 1 19 16.5V18"],
  forward: ["M15 6l5 5-5 5", "M20 11h-9.5A5.5 5.5 0 0 0 5 16.5V18"],
  search: ["M11 17.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z", "M15.8 15.8L21 21"],
  pencil: ["M4 20l4.5-1L19.5 8a2.1 2.1 0 0 0-3-3L5.5 16z", "M14.5 6.5l3 3"],
  clip: ["M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"],
  star: ["M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.5 9.7l5.9-.9z"],
  settings: ["M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z", "M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4L18 18M18 6l-1.6 1.6M7.6 16.4L6 18"],
  refresh: ["M20 11a8 8 0 1 0-2.3 5.7", "M20 5v6h-6"],
  close: ["M6 6l12 12M18 6L6 18"],
};

export type IconName = keyof typeof ICONS;

/** An inline 24×24 stroke icon; colour flows from `currentColor`. */
export function icon(name: IconName, className?: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  if (className) svg.setAttribute("class", className);
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
