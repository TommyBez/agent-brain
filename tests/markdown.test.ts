import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../components/markdown";

test("shared Markdown preserves internal, absolute, external and fragment link destinations", () => {
  const html = renderToStaticMarkup(
    createElement(Markdown, {
      markdown: [
        "[Project](/projects?q=roadmap&sort=title)",
        "[Canonical](https://brain.example/projects)",
        "[Source](https://example.org/article)",
        "[Section](#overview)",
        "[Email](mailto:owner@example.org)",
      ].join("\n\n"),
    }),
  );
  assert.match(html, /href="\/projects\?q=roadmap&amp;sort=title"/);
  assert.match(html, /href="https:\/\/brain\.example\/projects"/);
  assert.match(html, /href="https:\/\/example\.org\/article"/);
  assert.match(html, /href="#overview"/);
  assert.match(html, /href="mailto:owner@example\.org"/);
});

test("shared Markdown keeps GFM rendering and rejects unsafe link protocols", () => {
  const html = renderToStaticMarkup(
    createElement(Markdown, {
      markdown: [
        "| Page | Status |\n| --- | --- |\n| Project | ~~Archived~~ |",
        "[Unsafe](javascript:alert%281%29)",
        "<script>alert('raw HTML')</script>",
      ].join("\n\n"),
    }),
  );
  assert.match(html, /<table>/);
  assert.match(html, /<del>Archived<\/del>/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.doesNotMatch(html, /<script>/);
});
