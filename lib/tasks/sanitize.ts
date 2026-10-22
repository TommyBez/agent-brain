// Task text arrives from agents and pages: strip characters that hide or
// reorder text before it is stored, shown to the owner or handed to agents.

// Zero-width and invisible format characters, bidirectional controls and
// Unicode tag characters (used to smuggle invisible ASCII).
const INVISIBLE =
  /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/gu;
// C0/C1 controls except tab and line feed (carriage returns are normalized first).
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

function stripComments(value: string): string {
  // Removing one comment can join the halves of another; repeat until stable.
  let current = value;
  for (let pass = 0; pass < 8; pass++) {
    const next = current.replace(HTML_COMMENT, "");
    if (next === current) return next;
    current = next;
  }
  return current.replace(/<!--/g, "");
}

/** Multi-line task text: descriptions, notes, questions, evidence. */
export function sanitizeTaskText(value: string): string {
  const visible = value
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL, "")
    .replace(INVISIBLE, "");
  return stripComments(visible)
    .normalize("NFC")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/** Single-line task text: titles, criteria, labels, quotes. */
export function sanitizeTaskLine(value: string): string {
  return sanitizeTaskText(value).replace(/\s+/g, " ");
}
