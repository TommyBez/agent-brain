# Writing pages through MCP

Read this when constructing `write` or `append` arguments. The connected server's tool schemas define the current contract. The examples below illustrate payload construction; they are not a script to execute against sample entities.

## Read the current state

Resolve names and aliases, then call `read` with a returned ID or canonical slug. Successful tool results normally expose their value in `structuredContent.data` and as JSON in text content. The read value is the page itself, not an object with a `page` property. Tool failures set `isError: true` and expose `structuredContent.error`; an HTTP success alone is not proof of a successful mutation.

Use the page's current `version` as `expectedVersion`. Do not build a replacement from a search excerpt, a context bundle or an old conversation snapshot.

## Choose the mutation

| Intent | Tool and version rule |
| --- | --- |
| Add a passage while preserving existing content and metadata | `append` with `ref` and the current positive `expectedVersion`. |
| Change content, title, summary, aliases, tags or outgoing links | `write` with the page `id`, current positive `expectedVersion` and the full intended state. |
| Create an entity after resolving possible duplicates | `write` with `expectedVersion: 0` and **no `id`**. |

`write` replaces `markdown`, `summary`, `aliases`, `tags` and all outgoing `links`. Omitted summary becomes empty; omitted arrays become empty. Explicitly preserve values you intend to keep. Pass the existing `slug` unless renaming it deliberately. Do not spread a read result into a write: the input schema is strict and rejects read-only fields such as `version`, timestamps and `backlinks`.

An update's payload can be constructed as follows, where `page` is the fresh read result and `revisedMarkdown`, `changeReason` and `sourceReference` describe the actual change:

```js
const writeArguments = {
  id: page.id,
  expectedVersion: page.version,
  slug: page.slug,
  title: page.title,
  type: page.type,
  markdown: revisedMarkdown,
  summary: page.summary,
  aliases: page.aliases,
  tags: page.tags,
  links: page.links.map((link) => ({
    targetRef: link.targetId,
    type: link.type,
    label: link.label,
  })),
  reason: changeReason,
  source: sourceReference,
};
```

Adjust preserved fields only when the task calls for it, including updating an outdated summary. Link input uses `targetRef`, whereas read output uses `targetId`. Backlinks belong to other pages; copying them into outgoing links changes the graph's meaning.

For an additive passage, where `additionalMarkdown` is new sourced content:

```js
const appendArguments = {
  ref: page.id,
  expectedVersion: page.version,
  markdown: additionalMarkdown,
  reason: changeReason,
  source: sourceReference,
};
```

Append inserts a paragraph break before the new passage and preserves metadata and links. It does not update the summary or deduplicate repeated passages. Check the existing page before appending. Omit embedding fields for ordinary writes; indexing is handled separately.

## Organize entities and links

Current page types are `person`, `client`, `project`, `article`, `decision`, and `note`. Choose the type describing the entity; a decision can have its own page when its rationale and consequences warrant one, linked to its project. Prefer updating the appropriate existing page for small related facts.

Current typed links are `works_at`, `owns`, `part_of`, `relates_to`, `decided_in`, `references`, `depends_on`, `supersedes`, and `collaborates_with`. Resolve the target before using its canonical ID or slug as `targetRef`. The edited page is the source: a new decision `supersedes` an older decision, a project `depends_on` another project, and an article `references` its subject. Use the most specific supported relationship justified by evidence.

Provenance fields record why the mutation happened and where the information came from. They are revision metadata, not a substitute for source attribution in the page. Use a real conversation reference or an honest description such as a dated user conversation when no stable link is available.

## Reconcile failures

- `VERSION_CONFLICT`: read again, compare the concurrent changes and reconcile the intended update. Retry with the newly read version and reconciled content only when the evidence supports it. Never just replace the version number in an old payload. If conflicting claims require a user decision, report them instead of overwriting.
- `DUPLICATE_ENTITY`: resolve and inspect the existing page. Do not evade identity checks by inventing a suffixed slug or dropping a known alias.
- Missing target or validation error: correct the reference or payload using the live schema. Do not silently remove existing links to make a write pass.
- Unknown save outcome: read back before retrying. If an append is already present, do not append it again; if the outcome cannot be established, report the uncertainty and pause that mutation.

Read back successful mutations and use the returned page ID, slug and version in the completion report. The MCP interface does not expose a general merge or delete primitive; do not invent one or bypass it with database access.
