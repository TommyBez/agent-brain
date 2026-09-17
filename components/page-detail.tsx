import {
  ArrowLeft,
  ArrowUpRight,
  Clock3,
  FileText,
  Pencil,
} from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/markdown";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Pagination } from "@/components/workspace/pagination";
import { Empty, EntityIcon } from "@/components/workspace/primitives";
import { BrainError, type BrainPage } from "@/lib/brain/types";
import {
  getWorkspacePage,
  getWorkspaceRevision,
  getWorkspaceRevisions,
} from "@/lib/workspace/data";
import {
  type PaginationSearchParams,
  paginationOffset,
  WORKSPACE_PAGE_SIZE,
} from "@/lib/workspace/pagination";
import { formatDate } from "./brain-types";

export type PageParams = Promise<{ id: string }>;

export async function readPage(params: PageParams) {
  const { id } = await params;
  try {
    return await getWorkspacePage(id);
  } catch (error) {
    if (error instanceof BrainError && error.code === "NOT_FOUND") notFound();
    throw error;
  }
}

export function PageBackLink() {
  return (
    <Button variant="ghost" asChild>
      <Link href="/">
        <ArrowLeft size={16} /> All pages
      </Link>
    </Button>
  );
}

export async function PageVersion({ params }: { params: PageParams }) {
  const page = await readPage(params);
  return (
    <span className="min-w-0 wrap-anywhere">
      VERSION {page.version} · {page.slug}
    </span>
  );
}

export async function PageHeader({ params }: { params: PageParams }) {
  const page = await readPage(params);
  return <PageHeadingContent page={page} />;
}

function PageHeadingContent({ page }: { page: BrainPage }) {
  return (
    <>
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row">
        <div className="min-w-0 max-w-[760px] space-y-5">
          <Badge variant="secondary" className={`capitalize type-${page.type}`}>
            <EntityIcon type={page.type} size={13} /> {page.type}
          </Badge>
          <h1 className="wrap-anywhere font-serif text-4xl font-normal leading-[1.15] tracking-[-0.04em] sm:text-5xl">
            {page.title}
          </h1>
          {page.summary && (
            <p className="max-w-prose wrap-anywhere text-base text-muted-foreground leading-relaxed sm:text-lg">
              {page.summary}
            </p>
          )}
        </div>
        <Button variant="outline" asChild>
          <Link href={`/pages/${page.id}/edit`}>
            <Pencil size={15} /> Edit page
          </Link>
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>Updated {formatDate(page.updatedAt)}</span>
        <span aria-hidden="true">·</span>
        <span>{page.links.length + page.backlinks.length} connections</span>
        {page.tags.map((tag) => (
          <Badge
            variant="secondary"
            key={tag}
            className="max-w-full whitespace-normal wrap-anywhere"
          >
            {tag}
          </Badge>
        ))}
      </div>
    </>
  );
}

export async function PageNavigation({
  params,
  history = false,
}: {
  params: PageParams;
  history?: boolean;
}) {
  const { id } = await params;
  return (
    <nav aria-label="Page views" className="flex gap-2 border-b pb-4">
      <Button variant={!history ? "secondary" : "ghost"} asChild>
        <Link
          href={`/pages/${id}`}
          aria-current={!history ? "page" : undefined}
        >
          <FileText size={16} /> Page
        </Link>
      </Button>
      <Button variant={history ? "secondary" : "ghost"} asChild>
        <Link
          href={`/pages/${id}/history`}
          aria-current={history ? "page" : undefined}
        >
          <Clock3 size={16} /> History
        </Link>
      </Button>
    </nav>
  );
}

export async function PageBody({ params }: { params: PageParams }) {
  const page = await readPage(params);
  return (
    <article className="markdown-body reading-body min-w-0 max-w-[740px]">
      <Markdown markdown={page.markdown} />
    </article>
  );
}

export async function PageConnections({ params }: { params: PageParams }) {
  const page = await readPage(params);
  return (
    <Card
      role="complementary"
      aria-label="Page context"
      className="min-w-0 rounded-none border-0 border-l bg-transparent py-0 lg:sticky lg:top-8"
    >
      <CardHeader>
        <CardTitle>Connections</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6 text-sm">
        {page.links.length + page.backlinks.length ? (
          <>
            {page.links.length > 0 && (
              <ul className="space-y-4">
                {page.links.map((link) => (
                  <li key={link.id}>
                    <Item size="sm" asChild>
                      <Link href={`/pages/${link.targetId}`}>
                        <ItemContent className="min-w-0">
                          <ItemDescription className="wrap-anywhere">
                            {link.type.replaceAll("_", " ")}
                          </ItemDescription>
                          <ItemTitle className="wrap-anywhere">
                            {link.targetTitle || link.targetSlug}
                          </ItemTitle>
                          {link.label && (
                            <ItemDescription className="wrap-anywhere">
                              {link.label}
                            </ItemDescription>
                          )}
                        </ItemContent>
                        <ItemActions>
                          <ArrowUpRight size={16} />
                        </ItemActions>
                      </Link>
                    </Item>
                  </li>
                ))}
              </ul>
            )}
            {page.backlinks.length > 0 && (
              <section className="space-y-4">
                <h3 className="font-medium">Linked from</h3>
                <ul className="space-y-4">
                  {page.backlinks.map((link) => (
                    <li key={link.id}>
                      <Item size="sm" asChild>
                        <Link href={`/pages/${link.sourceId}`}>
                          <ItemContent className="min-w-0">
                            <ItemDescription className="wrap-anywhere">
                              {link.type.replaceAll("_", " ")}
                            </ItemDescription>
                            <ItemTitle className="wrap-anywhere">
                              {link.sourceTitle || link.sourceSlug}
                            </ItemTitle>
                          </ItemContent>
                          <ItemActions>
                            <ArrowUpRight size={16} />
                          </ItemActions>
                        </Link>
                      </Item>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        ) : (
          <p className="text-muted-foreground">
            No connections yet. Add a typed link to place this page in context.
          </p>
        )}
        {page.aliases.length > 0 && (
          <section className="space-y-2">
            <h3 className="font-medium">Also known as</h3>
            <p className="wrap-anywhere text-muted-foreground">
              {page.aliases.join(" · ")}
            </p>
          </section>
        )}
        <dl className="space-y-2 border-t pt-4">
          <dt className="font-medium">Created</dt>
          <dd className="text-muted-foreground">
            {formatDate(page.createdAt)}
          </dd>
          <dt className="font-medium">Retrieval</dt>
          <dd className="text-muted-foreground">
            {page.embeddedAt
              ? "Text + semantic search"
              : "Text search · awaiting embedding"}
          </dd>
        </dl>
      </CardContent>
    </Card>
  );
}

export async function PageHistory({
  params,
  searchParams,
}: {
  params: PageParams;
  searchParams: PaginationSearchParams;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const offset = paginationOffset(query.offset);
  const revisions = await getWorkspaceRevisions(id, offset);
  if (!revisions.length && offset === 0)
    return (
      <Empty
        icon={<Clock3 size={27} />}
        title="The first chapter."
        description="Saved versions will appear here as this page evolves."
      />
    );
  return (
    <>
      <ItemGroup>
        {revisions.slice(0, WORKSPACE_PAGE_SIZE).map((item) => (
          <Item key={item.id} asChild>
            <Link href={`/pages/${id}/history/${item.version}`}>
              <ItemMedia>
                <Badge variant="secondary">v{item.version}</Badge>
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle className="wrap-anywhere">
                  {item.reason || "Page saved"}
                </ItemTitle>
                <ItemDescription className="wrap-anywhere">
                  {item.source || "Workspace"} · {formatDate(item.createdAt)}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <ArrowUpRight size={16} />
              </ItemActions>
            </Link>
          </Item>
        ))}
      </ItemGroup>
      <Pagination
        path={`/pages/${id}/history`}
        offset={offset}
        hasMore={revisions.length > WORKSPACE_PAGE_SIZE}
      />
    </>
  );
}

type RevisionParams = Promise<{ id: string; version: string }>;

async function readPageRevision(params: RevisionParams) {
  const { id, version } = await params;
  const number = Number(version);
  if (!/^[1-9]\d*$/.test(version) || !Number.isSafeInteger(number)) notFound();
  try {
    return await getWorkspaceRevision(id, number);
  } catch (error) {
    if (error instanceof BrainError && error.code === "NOT_FOUND") notFound();
    throw error;
  }
}

export async function PageRevisionHeader({
  params,
}: {
  params: RevisionParams;
}) {
  const revision = await readPageRevision(params);
  return <PageHeadingContent page={revision.snapshot} />;
}

export async function PageRevision({ params }: { params: RevisionParams }) {
  const revision = await readPageRevision(params);
  return (
    <>
      <Alert className="mb-6">
        <Clock3 />
        <AlertTitle>Reading version {revision.version}</AlertTitle>
        <AlertDescription>
          <p>{formatDate(revision.createdAt)}</p>
          <Button variant="link" asChild>
            <Link href={`/pages/${revision.pageId}/history`}>
              Back to history
            </Link>
          </Button>
        </AlertDescription>
      </Alert>
      <article className="markdown-body">
        <Markdown markdown={revision.snapshot.markdown} />
      </article>
    </>
  );
}
