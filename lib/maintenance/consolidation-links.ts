/** Shared by proposal preparation and the source-preservation audit. */
export function markdownDestinations(text: string): Set<string> {
  const destinations = new Set<string>();
  const definitions = new Map<string, string>();
  const label = (value: string) =>
    value.trim().replace(/\s+/g, " ").toLowerCase();
  for (const match of text.matchAll(
    /^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^>\n]+)>|((?:\\.|[^\s])+))/gm,
  )) {
    definitions.set(label(match[1]), match[2] ?? match[3]);
  }
  for (const match of text.matchAll(/\]\(\s*/g)) {
    let i = match.index + match[0].length;
    const start = i;
    if (text[i] === "<") {
      const end = text.indexOf(">", i + 1);
      if (end >= 0) destinations.add(text.slice(i + 1, end));
      continue;
    }
    let nesting = 0;
    while (i < text.length) {
      if (text[i] === "\\") {
        i += 2;
        continue;
      }
      if (text[i] === "(") nesting++;
      else if (text[i] === ")") {
        if (nesting === 0) break;
        nesting--;
      } else if (/\s/.test(text[i]) && nesting === 0) break;
      i++;
    }
    if (i > start) destinations.add(text.slice(start, i));
  }
  for (const match of text.matchAll(/\[([^\]\n]+)\](?:\[([^\]\n]*)\])?/g)) {
    if (
      text[match.index + match[0].length] === ":" &&
      /^ {0,3}$/.test(
        text.slice(text.lastIndexOf("\n", match.index) + 1, match.index),
      )
    )
      continue;
    const destination = definitions.get(label(match[2] || match[1]));
    if (destination) destinations.add(destination);
  }
  return destinations;
}
