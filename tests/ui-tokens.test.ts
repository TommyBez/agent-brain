import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

function uiFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? uiFiles(path)
      : /\.(?:tsx?|css|svg)$/.test(entry.name)
        ? [path]
        : [];
  });
}

// Theme literals belong exclusively to CSS token declarations. Application UI
// uses semantic utilities; unmodified shadcn may also use Tailwind palette tokens.
const literalColor =
  /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
const paletteUtility =
  /\b(?:bg|text|border|divide|outline|ring|ring-offset|shadow|fill|stroke|accent|decoration|from|via|to|caret)-(?:white\b|black\b|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+\b)/;
const namedColor =
  /\b(?:color|background|backgroundColor|borderColor|fill|stroke)\s*[:=]\s*["'](?:white|black|red|green|blue|gray|grey|yellow|orange|purple|pink|silver|navy|teal|aqua|fuchsia|lime|maroon|olive)["']/i;

test("UI colors are defined by theme tokens, including vendored components", () => {
  const violations: string[] = [];
  for (const path of [...uiFiles("app"), ...uiFiles("components")]) {
    const file = relative(process.cwd(), path);
    readFileSync(path, "utf8")
      .split("\n")
      .forEach((line, index) => {
        const token =
          file === "app/globals.css" && /^\s*--[\w-]+\s*:/.test(line);
        if (
          (!token && literalColor.test(line)) ||
          (!file.startsWith("components/ui/") && paletteUtility.test(line)) ||
          namedColor.test(line)
        ) {
          violations.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
  }
  assert.deepEqual(
    violations,
    [],
    "Use semantic theme tokens instead of literal colors or palette utilities.",
  );
});
