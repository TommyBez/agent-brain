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
import { Button } from "@/components/ui/button";
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
    <Link
      href="/"
      className="text-link inline-flex items-center gap-[7px] text-primary text-xs font-semibold"
    >
      <ArrowLeft size={15} /> All pages
    </Link>
  );
}

export async function PageVersion({ params }: { params: PageParams }) {
  const page = await readPage(params);
  return (
    <span>
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
      <div className="detail-heading flex justify-between gap-6 items-start max-[460px]:flex-col max-[460px]:gap-0">
        <div>
          <span
            className={`type-tag inline-flex gap-[5px] items-center text-[9px] px-2 py-[3px] rounded bg-[#ebeee3] text-[#768566] capitalize whitespace-nowrap type-${page.type}`}
          >
            <EntityIcon type={page.type} size={13} /> {page.type}
          </span>
          <h1>{page.title}</h1>
          {page.summary && (
            <p className="page-summary max-w-[650px] text-[#7e8971] text-[15px] leading-[1.7] max-[460px]:text-[13px]">
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
      <div className="detail-meta flex gap-2 items-center flex-wrap mt-[23px] mb-[29px] text-[#9aa28e] text-[10px]">
        <span>Updated {formatDate(page.updatedAt)}</span>
        <span className="dot-separator px-[5px]">·</span>
        <span>{page.links.length + page.backlinks.length} connections</span>
        {page.tags.map((tag) => (
          <span
            className="metadata-tag px-[7px] py-[2px] rounded bg-[#edf0e5] text-[#839372] text-[9px]"
            key={tag}
          >
            {tag}
          </span>
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
    <nav
      aria-label="Page views"
      className="flex gap-6 border-b border-border mb-8 pb-3 text-xs"
    >
      <Link
        href={`/pages/${id}`}
        aria-current={!history ? "page" : undefined}
        className={`inline-flex items-center gap-2 py-1 ${!history ? "text-primary font-semibold" : "text-muted-foreground"}`}
      >
        <FileText size={15} /> Page
      </Link>
      <Link
        href={`/pages/${id}/history`}
        aria-current={history ? "page" : undefined}
        className={`inline-flex items-center gap-2 py-1 ${history ? "text-primary font-semibold" : "text-muted-foreground"}`}
      >
        <Clock3 size={15} /> History
      </Link>
    </nav>
  );
}

export async function PageBody({ params }: { params: PageParams }) {
  const page = await readPage(params);
  return (
    <article className="markdown-body">
      <Markdown markdown={page.markdown} />
    </article>
  );
}

export async function PageConnections({ params }: { params: PageParams }) {
  const page = await readPage(params);
  return (
    <aside className="page-context border-l border-border pl-[25px] max-[1200px]:pl-5 max-[960px]:border-l-0 max-[960px]:pl-0 max-[960px]:border-t max-[960px]:pt-[25px] max-[960px]:grid max-[960px]:grid-cols-2 max-[960px]:gap-x-5">
      <h3>CONNECTED KNOWLEDGE</h3>
      {page.links.length + page.backlinks.length ? (
        <>
          {page.links.map((link) => (
            <Link
              className="connected-page block w-full text-left py-[13px] border-b border-border"
              key={link.id}
              href={`/pages/${link.targetId}`}
            >
              <span>{link.type.replaceAll("_", " ")}</span>
              <strong>
                {link.targetTitle || link.targetSlug}
                <ArrowUpRight size={14} />
              </strong>
              {link.label && <p>{link.label}</p>}
            </Link>
          ))}
          {page.backlinks.length > 0 && (
            <h3 className="backlinks-title mt-[30px]!">LINKED FROM</h3>
          )}
          {page.backlinks.map((link) => (
            <Link
              className="connected-page block w-full text-left py-[13px] border-b border-border"
              key={link.id}
              href={`/pages/${link.sourceId}`}
            >
              <span>{link.type.replaceAll("_", " ")}</span>
              <strong>
                {link.sourceTitle || link.sourceSlug}
                <ArrowUpRight size={14} />
              </strong>
            </Link>
          ))}
        </>
      ) : (
        <p className="context-empty">
          No connections yet. Add a typed link to place this page in context.
        </p>
      )}
      {page.aliases.length > 0 && (
        <>
          <h3>ALSO KNOWN AS</h3>
          <p className="context-aliases">{page.aliases.join(" · ")}</p>
        </>
      )}
      <div className="page-provenance mt-9 border-t border-border pt-5">
        <span>FIRST REMEMBERED</span>
        <p>{formatDate(page.createdAt)}</p>
        <span>RETRIEVAL</span>
        <p>
          {page.embeddedAt
            ? "Text + semantic search"
            : "Text search · awaiting embedding"}
        </p>
      </div>
    </aside>
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
      <div className="revision-list">
        {revisions.slice(0, WORKSPACE_PAGE_SIZE).map((item) => (
          <Link
            href={`/pages/${id}/history/${item.version}`}
            className="revision-row flex items-center gap-[17px] w-full text-left py-5 px-[6px] border-b border-border"
            key={item.id}
          >
            <span className="version-number bg-[#e8eede] text-[#82966b] rounded-[5px] px-[9px] py-[6px] text-[10px] font-mono">
              v{item.version}
            </span>
            <div>
              <strong>{item.reason || "Page saved"}</strong>
              <p>
                {item.source || "Workspace"} · {formatDate(item.createdAt)}
              </p>
            </div>
            <ArrowUpRight size={17} />
          </Link>
        ))}
      </div>
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
      <div className="revision-banner px-[18px] py-[15px] bg-[#edf2e3] flex justify-between gap-[10px] text-[11px] text-[#7d9165] mb-[30px]">
        <span>
          Reading version {revision.version} · {formatDate(revision.createdAt)}
        </span>
        <Link
          className="text-primary font-semibold"
          href={`/pages/${revision.pageId}/history`}
        >
          Back to history
        </Link>
      </div>
      <article className="markdown-body">
        <Markdown markdown={revision.snapshot.markdown} />
      </article>
    </>
  );
}
