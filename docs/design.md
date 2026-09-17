# a native brain — interface direction

A personal knowledge library for its owner and their agents. The lowercase “a”
is the identifying mark; it also stands for “agent”.

## Research

[The full Mobbin research](./design-research.md) records 82 visually inspected
screens from 36 products, the shortlist, exclusions, and a source link for each
screen. This is a qualitative design comparison, not usability testing of those
products.

## Structure and visual language

- A shared top navigation replaces the permanent sidebar. Library, Graph and
  Activity remain one click away. The workspace menu contains collections,
  agent access, operations and the owner profile.
- The library uses a document grid with actual titles, summaries, types, tags and
  update times. It has three columns on desktop, two on tablet and one on mobile.
- Collections become horizontal navigation with actual counts. Switching
  collections preserves the search and sort; pagination resets appropriately.
- Warm paper, dark ink and a rust accent define the interface. Entity colors
  remain small semantic signals shared with the graph.
- Lora provides editorial headings and reading text; DM Sans provides interface
  text. Both variable fonts are self-hosted, with their OFL licenses in
  `app/fonts`. Sources: [Lora](https://github.com/google/fonts/tree/main/ofl/lora)
  and [DM Sans](https://github.com/google/fonts/tree/main/ofl/dmsans).
- The reading page has a controlled text width and secondary connections column.
  The editor gives more room to the title and text; connections and metadata are
  accessible through a native disclosure.
- Functional copy, real content and existing actions determine the composition.
  No fabricated metrics, generic cover images, decorative gradients or slogans.
- Colors remain centralized in `app/globals.css`. Vendored dark variants require
  an explicit dark theme; the current interface consistently uses its light
  theme, including when the operating system prefers dark.

## Verification

Authenticated local browser checks covered search, query-preserving collection
navigation, sorting, reading, editor preview, metadata disclosure and cancel,
menu navigation, global search, Command-K, empty collections, activity and graph
search with keyboard selection. Responsive checks covered 320px, 390px, 768px
and the desktop viewport. No knowledge pages, agent tokens, credentials or
maintenance jobs were changed during these checks.

The calculated text contrast minimum across the theme and entity text pairs is
4.61:1. TypeScript, lint, production build and 88 unit tests pass. Thirteen opt-in
integration tests were skipped. The design has been verified locally; this work
does not constitute a production deployment.
