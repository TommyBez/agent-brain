import { randomUUID } from "node:crypto";
import { z } from "zod";
import * as schemas from "../../lib/brain/schemas";
import type { PageType } from "../../lib/brain/types";
import { normalizeIdentity, slugify } from "../../lib/brain/utils";

export type Page = z.infer<typeof schemas.writeSchema> & {
  id: string;
  slug: string;
  version: number;
};
export type Trace = {
  tool: string;
  input: unknown;
  output: unknown;
  error?: string;
  pageId?: string;
  version?: number;
  mutation?: boolean;
};

export const toolSchemas = {
  context: schemas.contextSchema,
  resolve: schemas.resolveSchema,
  search: schemas.searchSchema,
  read: schemas.readSchema,
  related: schemas.relatedSchema,
  list_pages: schemas.listPagesSchema,
  write: schemas.writeSchema,
  append: schemas.appendSchema,
  read_skill: z.object({ path: z.string() }).strict(),
};
const descriptions: Record<keyof typeof toolSchemas, string> = {
  context:
    "Retrieve a bounded context bundle. Read full pages before changing them.",
  resolve:
    "Resolve titles, aliases or slugs; inspect candidates before creating pages.",
  search: "Find pages by plain-text query and optional type.",
  read: "Read a complete page by canonical slug or ID, including version and links.",
  related: "Follow outgoing links and backlinks around a page.",
  list_pages: "List pages with optional type/query filter and pagination.",
  write:
    "Create with expectedVersion 0 or replace using ID and current version. Replaces metadata and outgoing links too.",
  append:
    "Append Markdown with the current expectedVersion, preserving metadata and links.",
  read_skill:
    "Read SKILL.md or a linked reference by its path relative to the skill folder.",
};
export const toolDefinitions = Object.entries(toolSchemas).map(
  ([name, schema]) => ({
    type: "function" as const,
    function: {
      name,
      description: descriptions[name as keyof typeof toolSchemas],
      parameters: z.toJSONSchema(schema, { unrepresentable: "any" }),
    },
  }),
);

const retrieval = {
  mode: "text-and-graph",
  embeddingSource: "unavailable",
  embeddingModel: null,
};

/** No DB, network, filesystem, shell, or real MCP connection. Each trial owns a fresh copy. */
export class FakeBrain {
  readonly pages: Page[];
  readonly trace: Trace[];
  constructor(
    initial: Page[],
    private readonly files: Record<string, string>,
    trace: Trace[] = [],
    private readonly nextId: () => string = randomUUID,
  ) {
    this.pages = structuredClone(initial);
    this.trace = structuredClone(trace);
  }

  private find(ref: string): Page {
    const page = this.pages.find((p) => p.id === ref || p.slug === ref);
    if (!page)
      throw new Error(
        "NOT_FOUND: use a canonical slug or ID from resolve/search.",
      );
    return page;
  }

  private summary(page: Page) {
    const {
      markdown: _markdown,
      links: _links,
      expectedVersion: _expected,
      reason: _reason,
      source: _source,
      ...summary
    } = page;
    return {
      ...summary,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-08T10:00:00.000Z",
      embeddedAt: null,
    };
  }

  private decorated(page: Page) {
    const edges = this.pages.flatMap((source) =>
      source.links.map((link, i) => {
        const target = this.find(link.targetRef);
        return {
          id: `${source.id}-${i}`,
          sourceId: source.id,
          sourceSlug: source.slug,
          sourceTitle: source.title,
          targetId: target.id,
          targetSlug: target.slug,
          targetTitle: target.title,
          type: link.type,
          label: link.label,
        };
      }),
    );
    return {
      ...this.summary(page),
      markdown: page.markdown,
      links: edges.filter((e) => e.sourceId === page.id),
      backlinks: edges.filter((e) => e.targetId === page.id),
    };
  }

  private ranked(query: string, type?: PageType) {
    const terms = normalizeIdentity(query)
      .split(/\W+/)
      .filter((t) => t.length > 2);
    return this.pages
      .filter((p) => !type || p.type === type)
      .map((page) => {
        const text = normalizeIdentity(
          `${page.title} ${page.slug} ${page.aliases.join(" ")} ${page.summary} ${page.markdown}`,
        );
        return { page, score: terms.filter((t) => text.includes(t)).length };
      })
      .filter((hit) => hit.score > 0)
      .sort(
        (a, b) => b.score - a.score || a.page.slug.localeCompare(b.page.slug),
      )
      .map((hit) => hit.page);
  }

  call(tool: string, input: unknown): unknown {
    const entry: Trace = { tool, input: structuredClone(input), output: null };
    try {
      entry.output = structuredClone(this.execute(tool, input, entry));
    } catch (error) {
      entry.error = error instanceof Error ? error.message : "Tool failed";
      entry.output = { error: entry.error };
    }
    this.trace.push(entry);
    return entry.output;
  }

  private execute(tool: string, input: unknown, entry: Trace): unknown {
    switch (tool) {
      case "read_skill": {
        const { path } = toolSchemas.read_skill.parse(input);
        if (!Object.hasOwn(this.files, path))
          throw new Error(
            "Unknown skill file; use a path from SKILL.md or a linked guide.",
          );
        return { path, content: this.files[path] };
      }
      case "read": {
        const page = this.find(schemas.readSchema.parse(input).ref);
        entry.pageId = page.id;
        entry.version = page.version;
        return this.decorated(page);
      }
      case "resolve": {
        const data = schemas.resolveSchema.parse(input);
        const name = normalizeIdentity(data.name);
        const exact = this.pages.filter(
          (p) =>
            (!data.type || p.type === data.type) &&
            [p.title, p.slug, ...p.aliases].some(
              (s) => normalizeIdentity(s) === name,
            ),
        );
        const candidates = [
          ...new Set([...exact, ...this.ranked(data.name, data.type)]),
        ]
          .slice(0, data.limit)
          .map((p) => ({
            ...this.summary(p),
            exact: exact.includes(p),
            confidence: exact.includes(p) ? 1 : 0.5,
          }));
        return {
          match: exact.length === 1 ? candidates[0] : null,
          ambiguous: exact.length > 1,
          candidates,
        };
      }
      case "search": {
        const data = schemas.searchSchema.parse(input);
        return {
          results: this.ranked(data.query, data.type)
            .slice(0, data.limit)
            .map((p) => this.summary(p)),
          retrieval,
        };
      }
      case "context": {
        const data = schemas.contextSchema.parse(input);
        const pages = [
          ...new Set([
            ...data.refs.map((ref) => this.find(ref)),
            ...this.ranked(data.query),
          ]),
        ].slice(0, data.limit);
        const markdown = pages
          .map(
            (p) =>
              `## ${p.title}\n[${p.slug}] · ${p.type} · v${p.version}\n${p.markdown}`,
          )
          .join("\n\n");
        return {
          query: data.query,
          markdown: markdown.slice(0, data.maxCharacters),
          citations: pages.map((p) => this.summary(p)),
          gaps:
            markdown.length > data.maxCharacters
              ? ["Context truncated; read full pages."]
              : [],
          retrieval,
        };
      }
      case "list_pages": {
        const data = schemas.listPagesSchema.parse(input);
        const pages = (
          data.query
            ? this.ranked(data.query, data.type)
            : this.pages.filter((p) => !data.type || p.type === data.type)
        ).filter(
          (p) =>
            !data.relationship || p.relationships.includes(data.relationship),
        );
        return {
          pages: pages
            .slice(data.offset, data.offset + data.limit)
            .map((p) => this.summary(p)),
          total: pages.length,
          offset: data.offset,
          limit: data.limit,
        };
      }
      case "related": {
        const data = schemas.relatedSchema.parse(input);
        const seed = this.find(data.ref);
        const ids = new Set([seed.id]);
        for (let depth = 0; depth < data.depth; depth++) {
          const previous = new Set(ids);
          for (const p of this.pages)
            for (const edge of p.links) {
              const target = this.find(edge.targetRef);
              if (previous.has(p.id) || previous.has(target.id)) {
                ids.add(p.id);
                ids.add(target.id);
              }
            }
        }
        return {
          page: this.summary(seed),
          pages: this.pages
            .filter((p) => ids.has(p.id) && p.id !== seed.id)
            .slice(0, data.limit)
            .map((p) => this.summary(p)),
          links: [
            ...this.decorated(seed).links,
            ...this.decorated(seed).backlinks,
          ],
        };
      }
      case "write": {
        const data = schemas.writeSchema.parse(input);
        const previous = data.id ? this.find(data.id) : undefined;
        if (previous && previous.version !== data.expectedVersion)
          throw new Error(
            "VERSION_CONFLICT: read and reconcile before retrying.",
          );
        const slug = data.slug ?? previous?.slug ?? slugify(data.title);
        if (this.pages.some((p) => p.slug === slug && p.id !== previous?.id))
          throw new Error("SLUG_CONFLICT");
        const links = data.links.map((link) => ({
          ...link,
          targetRef: this.find(link.targetRef).id,
        }));
        const next: Page = {
          ...data,
          links,
          id: previous?.id ?? this.nextId(),
          slug,
          version: (previous?.version ?? 0) + 1,
        };
        if (previous) this.pages[this.pages.indexOf(previous)] = next;
        else this.pages.push(next);
        entry.pageId = next.id;
        entry.version = next.version;
        entry.mutation = true;
        return this.decorated(next);
      }
      case "append": {
        const data = schemas.appendSchema.parse(input);
        const page = this.find(data.ref);
        if (page.version !== data.expectedVersion)
          throw new Error(
            "VERSION_CONFLICT: read and reconcile before retrying.",
          );
        const markdown = `${page.markdown}\n\n${data.markdown}`;
        const { version: _version, ...payload } = page;
        schemas.writeSchema.parse({
          ...payload,
          markdown,
          expectedVersion: page.version,
        });
        page.markdown = markdown;
        page.version++;
        entry.pageId = page.id;
        entry.version = page.version;
        entry.mutation = true;
        return this.decorated(page);
      }
      default:
        throw new Error(`Unknown tool: ${tool}`);
    }
  }
}
