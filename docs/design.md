# a native brain — interface direction

A personal knowledge library for its owner and their agents. The lowercase “a”
is the identifying mark; it also stands for “agent”.

## Research

[The full Mobbin research](./design-research.md) records 82 visually inspected
screens from 36 products, the shortlist, exclusions, and a source link for each
screen. This is a qualitative design comparison, not usability testing of those
products.

## Structure and visual language

- A collapsible sidebar (shadcn `Sidebar`, `collapsible="icon"`) holds the
  workspace views, collections with live counts, settings and the owner menu.
  ⌘B collapses it to an icon rail; on mobile it opens as a sheet from the
  header trigger.
- The command menu (shadcn `Command`, ⌘K or the header search button) is the
  global search: it matches entity names and aliases first, then page text, and
  also jumps to collections, settings and “New …” forms. The library keeps a
  submit-to-filter field for its own list.
- The library uses a document grid with actual titles, summaries, types, tags and
  update times. Its columns follow the available width (container queries), so
  the sidebar never squeezes cards.
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

## Tasks

- The research excluded Kanban boards ([design-research.md](./design-research.md),
  “Soluzioni escluse”) because pages are linked entities, not items moving
  through states. Tasks are such a stateful process, so the exclusion is lifted
  for them only: `/tasks/board` groups tasks by status, and every drag has a
  keyboard alternative in the card's “Move to…” menu. Knowledge pages keep the
  document grid.
- `/tasks` puts what needs the owner first (triage by source, questions,
  reviews, human steps, claims taken on request, suggestions), then the open
  work as tables. Filters, sort and pagination live in the URL; saved views are
  named URL filters listed under Tasks in the sidebar.
- Task text written by agents is labelled “Written by …”, rendered as Markdown
  without raw HTML or images, and never styled as instructions.
- Status tokens (`--status-*`) tint the existing secondary Badge, the way entity
  types do; priority tokens (`--priority-*`) color text with an icon, so color
  is never the only signal. Contrast, computed by hand with the WCAG formula:
  status text on its tint 4.99:1 (canceled) to 6.03:1 (done), and at least
  5.40:1 on the page background; priority text at least 4.61:1 (low, on
  `--accent`) and 4.75:1 or more on every other surface. The theme minimum of
  4.61:1 holds.

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
