"use client";

import {
  ArrowLeft,
  ArrowUpRight,
  Clock3,
  FileText,
  Link2,
  LoaderCircle,
  Pencil,
  Plus,
  Save,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { LinkType, PageType } from "@/lib/brain/types";
import {
  type BrainPage,
  entityTypes,
  formatDate,
  linkTypes,
  type PageSummary,
  type Revision,
  request,
} from "./brain-types";
import { Empty, EntityIcon, Loading } from "./brain-workspace";

type DraftLink = { targetRef: string; type: LinkType; label: string };
export function PageDetail({
  id,
  initialType,
  onBack,
  onOpen,
  onSaved,
}: {
  id: string | null;
  initialType: string;
  onBack: () => void;
  onOpen: (id: string) => void;
  onSaved: (id: string) => void;
}) {
  const [page, setPage] = useState<BrainPage | null>(null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [editing, setEditing] = useState(!id);
  const [tab, setTab] = useState<"page" | "history">("page");
  const [title, setTitle] = useState("");
  const [type, setType] = useState<PageType>(
    (initialType || "note") as PageType,
  );
  const [summary, setSummary] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [aliases, setAliases] = useState("");
  const [tags, setTags] = useState("");
  const [reason, setReason] = useState("");
  const [links, setLinks] = useState<DraftLink[]>([]);
  const [linkTarget, setLinkTarget] = useState("");
  const [linkType, setLinkType] = useState<LinkType>("relates_to");
  const [choices, setChoices] = useState<PageSummary[]>([]);
  const [busy, setBusy] = useState(Boolean(id));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [preview, setPreview] = useState(false);
  const [revision, setRevision] = useState<Revision | null>(null);
  const [duplicates, setDuplicates] = useState<PageSummary[]>([]);
  const populate = useCallback((data: BrainPage) => {
    setTitle(data.title);
    setType(data.type);
    setSummary(data.summary);
    setMarkdown(data.markdown);
    setAliases(data.aliases.join(", "));
    setTags(data.tags.join(", "));
    setLinks(
      data.links.map((link) => ({
        targetRef: link.targetId,
        type: link.type,
        label: link.label || "",
      })),
    );
  }, []);
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    request<{ page: BrainPage; revisions: Revision[] }>(
      `/api/brain/pages/${encodeURIComponent(id)}`,
      { signal: controller.signal },
    )
      .then((data) => {
        setPage(data.page);
        setRevisions(data.revisions);
        populate(data.page);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Unable to read this page.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [id, populate]);
  useEffect(() => {
    if (!editing) return;
    const controller = new AbortController();
    request<{ pages: PageSummary[] }>("/api/brain/pages?limit=100", {
      signal: controller.signal,
    })
      .then((data) => setChoices(data.pages.filter((item) => item.id !== id)))
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Unable to load connection choices.",
          );
      });
    return () => controller.abort();
  }, [editing, id]);
  useEffect(() => {
    if (id || title.trim().length < 3) {
      setDuplicates([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      request<{ candidates: PageSummary[] }>(
        `/api/brain/resolve?name=${encodeURIComponent(title)}&type=${type}`,
        { signal: controller.signal },
      )
        .then((data) => setDuplicates(data.candidates))
        .catch(() => {});
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [id, title, type]);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setConflict(false);
    try {
      const data = await request<{ page: BrainPage }>(
        id ? `/api/brain/pages/${encodeURIComponent(id)}` : "/api/brain/pages",
        {
          method: id ? "PATCH" : "POST",
          body: JSON.stringify({
            expectedVersion: page?.version ?? 0,
            title,
            type,
            summary,
            markdown,
            aliases: aliases
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
            tags: tags
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
            links,
            reason:
              reason || (id ? "Edited in workspace" : "Created in workspace"),
          }),
        },
      );
      setPage(data.page);
      setEditing(false);
      setReason("");
      onSaved(data.page.id);
    } catch (cause) {
      setConflict(
        Boolean(id) && (cause as { code?: string }).code === "VERSION_CONFLICT",
      );
      setError(cause instanceof Error ? cause.message : "Unable to save page.");
    } finally {
      setSaving(false);
    }
  }
  async function loadLatest() {
    if (!id) return;
    setSaving(true);
    try {
      const data = await request<{ page: BrainPage; revisions: Revision[] }>(
        `/api/brain/pages/${encodeURIComponent(id)}`,
      );
      setPage(data.page);
      setRevisions(data.revisions);
      setConflict(false);
      setError(
        "Latest version loaded for comparison. Your draft is still in the editor. Review the current page below, then save your reconciled changes.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to load latest version.",
      );
    } finally {
      setSaving(false);
    }
  }
  function discard() {
    if (page) populate(page);
    setEditing(false);
    setError("");
    setPreview(false);
  }
  if (busy) return <Loading />;
  if (error && !page && id)
    return (
      <>
        <Button
          type="button"
          variant="ghost"
          className="text-link h-auto justify-start inline-flex items-center gap-[7px] p-[0] text-primary bg-transparent [font-size:12px] font-semibold text-left"
          onClick={onBack}
        >
          <ArrowLeft size={15} /> Back to pages
        </Button>
        <div
          className="message [border:1px_solid_#d9dece] [background:#edf0e5] p-[16px_18px] rounded-[6px] [font-size:13px] m-[18px_0] error"
          role="alert"
        >
          {error}
        </div>
      </>
    );
  return (
    <div className="page-detail">
      <div className="detail-topline flex justify-between gap-5 pb-[35px] items-center max-[740px]:pb-[27px]">
        <Button
          type="button"
          variant="ghost"
          className="text-link h-auto justify-start inline-flex items-center gap-[7px] p-[0] text-primary bg-transparent [font-size:12px] font-semibold text-left"
          onClick={onBack}
        >
          <ArrowLeft size={15} /> All pages
        </Button>
        <span>
          {page ? `VERSION ${page.version} · ${page.slug}` : "NEW PAGE"}
        </span>
      </div>
      {editing ? (
        <form onSubmit={save} className="page-editor">
          <div className="editor-heading flex items-center justify-between gap-5 mb-[30px] max-[460px]:flex-col max-[460px]:items-start max-[460px]:gap-[13px]">
            <div>
              <span className="eyebrow [font-size:10px] font-semibold tracking-[.16em] text-primary">
                {id ? "REFINE WHAT YOU KNOW" : "MAKE ROOM FOR A THOUGHT"}
              </span>
              <h1>
                {id ? "Edit page" : "A new page"}
                <span className="heading-dot [color:#839567]">.</span>
              </h1>
            </div>
            <div className="button-group flex gap-[10px] items-center">
              {id && (
                <Button
                  type="button"
                  variant="outline"
                  className="button bg-transparent [border:1px_solid_#d8dbcf] rounded-[6px] p-[10px_15px] inline-flex items-center justify-center gap-2 leading-[1.3] font-medium [font-size:12px] min-h-[39px] [transition:background_.15s,_border-color_.15s,_transform_.15s] whitespace-nowrap"
                  onClick={discard}
                >
                  Cancel
                </Button>
              )}
              <Button
                type="submit"
                variant="default"
                className="button bg-transparent [border:1px_solid_#d8dbcf] rounded-[6px] p-[10px_15px] inline-flex items-center justify-center gap-2 leading-[1.3] font-medium [font-size:12px] min-h-[39px] [transition:background_.15s,_border-color_.15s,_transform_.15s] whitespace-nowrap primary"
                disabled={saving}
              >
                {saving ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <Save size={16} />
                )}{" "}
                Save page
              </Button>
            </div>
          </div>
          {error && (
            <div
              className={`message [border:1px_solid_#d9dece] [background:#edf0e5] p-[16px_18px] rounded-[6px] [font-size:13px] m-[18px_0] ${conflict ? "warning" : "error"}`}
              role="alert"
            >
              {error}
              {conflict && (
                <div>
                  <p>
                    Another writer saved this page. Your draft is preserved.
                    Load the current version, compare it with your draft, and
                    reconcile the changes.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    className="button bg-transparent [border:1px_solid_#d8dbcf] rounded-[6px] p-[10px_15px] inline-flex items-center justify-center gap-2 leading-[1.3] font-medium [font-size:12px] min-h-[39px] [transition:background_.15s,_border-color_.15s,_transform_.15s] whitespace-nowrap"
                    onClick={loadLatest}
                  >
                    Load latest version
                  </Button>
                </div>
              )}
            </div>
          )}
          <div className="editor-fields grid grid-cols-[2fr_1fr] gap-[18px] mb-[23px]">
            <Label className="title-field">
              Title
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="A person, a project, an idea…"
                maxLength={200}
                required
              />
            </Label>
            <Label>
              Page type
              <NativeSelect
                value={type}
                onChange={(e) => setType(e.target.value as PageType)}
              >
                {entityTypes.map((item) => (
                  <NativeSelectOption key={item.id} value={item.id}>
                    {item.singular}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Label>
          </div>
          {duplicates.length > 0 && (
            <div className="duplicate-notice mb-5 p-[16px_18px] [border-left:2px_solid_#b6c59b] [background:#eef2e3] [font-size:12px] [color:#778d5e]">
              <strong>A page may already exist.</strong>
              <p>Read a possible match before creating another entity.</p>
              {duplicates.map((match) => (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-link h-auto justify-start inline-flex items-center gap-[7px] p-[0] text-primary bg-transparent [font-size:12px] font-semibold text-left"
                  key={match.id}
                  onClick={() => onOpen(match.id)}
                >
                  {match.title}
                  <ArrowUpRight size={14} />
                </Button>
              ))}
            </div>
          )}
          <Label>
            Summary
            <Input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              maxLength={2000}
              placeholder="A sentence that captures what this page is about."
            />
          </Label>
          <Tabs
            value={preview ? "preview" : "write"}
            onValueChange={(value) => setPreview(value === "preview")}
          >
            <div className="flex items-center justify-between mt-5 mb-2">
              <Label htmlFor="markdown-content">Page content</Label>
              <TabsList className="h-8">
                <TabsTrigger className="text-xs" value="write">
                  Write
                </TabsTrigger>
                <TabsTrigger className="text-xs" value="preview">
                  Preview
                </TabsTrigger>
              </TabsList>
            </div>
            <TabsContent
              value="preview"
              className="markdown-body min-h-[420px] rounded-md border border-border p-6 mb-6"
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {markdown || "*Your page is waiting for its first words.*"}
              </ReactMarkdown>
            </TabsContent>
            <TabsContent value="write">
              <Textarea
                id="markdown-content"
                className="min-h-[420px] resize-y font-mono text-xs leading-8 p-5 mb-6"
                value={markdown}
                onChange={(e) => setMarkdown(e.target.value)}
                placeholder={
                  "## Overview\n\nWhat is useful to remember?\n\n## Context\n\nAdd facts, sources, and the decisions behind them."
                }
                required
              />
            </TabsContent>
          </Tabs>
          <div className="editor-fields grid grid-cols-[2fr_1fr] gap-[18px] mb-[23px]">
            <Label>
              Aliases
              <Input
                value={aliases}
                onChange={(e) => setAliases(e.target.value)}
                placeholder="Other names, separated by commas"
              />
            </Label>
            <Label>
              Tags
              <Input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="Tags, separated by commas"
              />
            </Label>
          </div>
          <div className="editor-links [border-top:1px_solid_var(--line)] [border-bottom:1px_solid_var(--line)] p-[22px_0] mb-[23px]">
            <h3>
              <Link2 size={17} /> Connections
            </h3>
            <p className="form-note [font-size:11px] text-muted-foreground font-normal leading-[1.65]">
              Give every relationship a meaning.
            </p>
            {links.map((link, index) => (
              <div
                className="draft-link flex gap-3 items-center [font-size:12px] p-[11px_0] [border-bottom:1px_solid_var(--line)] max-[460px]:gap-2 max-[460px]:[font-size:10px]"
                key={`${link.targetRef}-${link.type}`}
              >
                <span className="relationship-label [color:#97a284] [font-size:10px] max-[460px]:[font-size:8px]">
                  {link.type.replaceAll("_", " ")}
                </span>
                <strong>
                  {choices.find((p) => p.id === link.targetRef)?.title ||
                    page?.links.find((l) => l.targetId === link.targetRef)
                      ?.targetTitle ||
                    link.targetRef}
                </strong>
                <Button
                  type="button"
                  variant="ghost"
                  className="icon-button bg-transparent w-[30px] h-[30px] rounded-[5px] inline-flex items-center justify-center text-muted-foreground shrink-0"
                  aria-label="Remove connection"
                  onClick={() => setLinks(links.filter((_, i) => i !== index))}
                >
                  <X size={15} />
                </Button>
              </div>
            ))}
            <div className="link-composer flex gap-[10px] mt-[15px] max-[460px]:flex-wrap">
              <Label>
                <span className="sr-only">Relationship type</span>
                <NativeSelect
                  value={linkType}
                  onChange={(e) => setLinkType(e.target.value as LinkType)}
                >
                  {linkTypes.map((item) => (
                    <NativeSelectOption key={item} value={item}>
                      {item.replaceAll("_", " ")}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Label>
              <Label className="link-target flex-[1]">
                <span className="sr-only">Page to connect</span>
                <NativeSelect
                  value={linkTarget}
                  onChange={(e) => setLinkTarget(e.target.value)}
                >
                  <NativeSelectOption value="">
                    Choose a page…
                  </NativeSelectOption>
                  {choices.map((item) => (
                    <NativeSelectOption key={item.id} value={item.id}>
                      {item.title}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Label>
              <Button
                type="button"
                variant="outline"
                className="button bg-transparent [border:1px_solid_#d8dbcf] rounded-[6px] p-[10px_15px] inline-flex items-center justify-center gap-2 leading-[1.3] font-medium [font-size:12px] min-h-[39px] [transition:background_.15s,_border-color_.15s,_transform_.15s] whitespace-nowrap"
                disabled={
                  !linkTarget ||
                  links.some(
                    (link) =>
                      link.targetRef === linkTarget && link.type === linkType,
                  )
                }
                onClick={() => {
                  setLinks([
                    ...links,
                    { targetRef: linkTarget, type: linkType, label: "" },
                  ]);
                  setLinkTarget("");
                }}
              >
                <Plus size={15} /> Add
              </Button>
            </div>
          </div>
          <Label>
            Reason for this change
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="What changed, and why?"
              maxLength={2000}
            />
          </Label>
          {id && error.startsWith("Latest version") && page && (
            <details className="latest-comparison m-[20px_0] p-5 [background:#f4f1e3] [border:1px_solid_#dfd6b6]">
              <summary>Current saved version ({page.version})</summary>
              <div className="markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {page.markdown}
                </ReactMarkdown>
              </div>
            </details>
          )}
          <div className="editor-bottom flex justify-between items-center p-[20px_0_10px] [border-top:1px_solid_var(--line)]">
            <span>Markdown supported · Changes are versioned</span>
            <Button
              type="submit"
              variant="default"
              className="button bg-transparent [border:1px_solid_#d8dbcf] rounded-[6px] p-[10px_15px] inline-flex items-center justify-center gap-2 leading-[1.3] font-medium [font-size:12px] min-h-[39px] [transition:background_.15s,_border-color_.15s,_transform_.15s] whitespace-nowrap primary"
              disabled={saving}
            >
              <Save size={16} /> Save page
            </Button>
          </div>
        </form>
      ) : (
        page && (
          <>
            <div className="detail-heading flex justify-between gap-6 items-start max-[460px]:flex-col max-[460px]:gap-[0]">
              <div>
                <span
                  className={`type-tag inline-flex gap-[5px] items-center [justify-self:start] [font-size:9px] p-[3px_8px] rounded-[4px] [background:#ebeee3] [color:#768566] [text-transform:capitalize] whitespace-nowrap max-[460px]:[font-size:8px] max-[460px]:p-[3px_6px] type-${page.type}`}
                >
                  <EntityIcon type={page.type} size={13} /> {page.type}
                </span>
                <h1>{page.title}</h1>
                {page.summary && (
                  <p className="page-summary max-w-[650px] [color:#7e8971] [font-size:15px] leading-[1.7] max-[460px]:[font-size:13px]">
                    {page.summary}
                  </p>
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                className="button bg-transparent [border:1px_solid_#d8dbcf] rounded-[6px] p-[10px_15px] inline-flex items-center justify-center gap-2 leading-[1.3] font-medium [font-size:12px] min-h-[39px] [transition:background_.15s,_border-color_.15s,_transform_.15s] whitespace-nowrap"
                onClick={() => {
                  setEditing(true);
                  setRevision(null);
                }}
              >
                <Pencil size={15} /> Edit page
              </Button>
            </div>
            <div className="detail-meta flex gap-2 items-center flex-wrap m-[23px_0_29px] [color:#9aa28e] [font-size:10px] max-[460px]:[font-size:9px]">
              <span>Updated {formatDate(page.updatedAt)}</span>
              <span className="dot-separator [color:#a9ae9f] p-[0_5px]">·</span>
              <span>
                {page.links.length + page.backlinks.length} connections
              </span>
              {page.tags.map((tag) => (
                <span
                  className="metadata-tag p-[2px_7px] rounded-[3px] [background:#edf0e5] [color:#839372] [font-size:9px]"
                  key={tag}
                >
                  {tag}
                </span>
              ))}
            </div>
            <Tabs
              value={tab}
              onValueChange={(value) => {
                setTab(value as "page" | "history");
                setRevision(null);
              }}
            >
              <TabsList
                variant="line"
                className="w-full justify-start gap-6 border-b border-border rounded-none mb-8 pb-3"
              >
                <TabsTrigger value="page" className="grow-0 text-xs">
                  <FileText size={15} /> Page
                </TabsTrigger>
                <TabsTrigger value="history" className="grow-0 text-xs">
                  <Clock3 size={15} /> History{" "}
                  <span className="rounded bg-secondary px-1.5 text-[10px]">
                    {revisions.length}
                  </span>
                </TabsTrigger>
              </TabsList>
              <TabsContent value={tab}>
                {tab === "page" ? (
                  <div className="reading-layout grid grid-cols-[minmax(0,1fr)_218px] gap-[50px] max-[1200px]:gap-[30px] max-[1200px]:grid-cols-[minmax(0,1fr)_185px] max-[960px]:grid-cols-[1fr]">
                    <article className="markdown-body">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {page.markdown}
                      </ReactMarkdown>
                    </article>
                    <aside className="page-context [border-left:1px_solid_var(--line)] pl-[25px] max-[1200px]:pl-5 max-[960px]:[border-left:0] max-[960px]:pl-[0] max-[960px]:[border-top:1px_solid_var(--line)] max-[960px]:pt-[25px] max-[960px]:grid max-[960px]:grid-cols-[repeat(2,1fr)] max-[960px]:gap-[0_20px]">
                      <h3>CONNECTED KNOWLEDGE</h3>
                      {page.links.length + page.backlinks.length ? (
                        <>
                          {page.links.map((link) => (
                            <Button
                              type="button"
                              variant="ghost"
                              className="connected-page h-auto whitespace-normal block w-full text-left bg-transparent p-[13px_0] [border-bottom:1px_solid_var(--line)]!"
                              key={link.id}
                              onClick={() => onOpen(link.targetId)}
                            >
                              <span>{link.type.replaceAll("_", " ")}</span>
                              <strong>
                                {link.targetTitle || link.targetSlug}
                                <ArrowUpRight size={14} />
                              </strong>
                              {link.label && <p>{link.label}</p>}
                            </Button>
                          ))}
                          {page.backlinks.length > 0 && (
                            <h3 className="backlinks-title mt-[30px]!">
                              LINKED FROM
                            </h3>
                          )}
                          {page.backlinks.map((link) => (
                            <Button
                              type="button"
                              variant="ghost"
                              className="connected-page h-auto whitespace-normal block w-full text-left bg-transparent p-[13px_0] [border-bottom:1px_solid_var(--line)]!"
                              key={link.id}
                              onClick={() => onOpen(link.sourceId)}
                            >
                              <span>{link.type.replaceAll("_", " ")}</span>
                              <strong>
                                {link.sourceTitle || link.sourceSlug}
                                <ArrowUpRight size={14} />
                              </strong>
                            </Button>
                          ))}
                        </>
                      ) : (
                        <p className="context-empty">
                          No connections yet. Add a typed link to place this
                          page in context.
                        </p>
                      )}
                      {page.aliases.length > 0 && (
                        <>
                          <h3>ALSO KNOWN AS</h3>
                          <p className="context-aliases">
                            {page.aliases.join(" · ")}
                          </p>
                        </>
                      )}
                      <div className="page-provenance mt-9 [border-top:1px_solid_var(--line)] pt-5">
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
                  </div>
                ) : revision ? (
                  <>
                    <div className="revision-banner p-[15px_18px] [background:#edf2e3] flex justify-between gap-[10px] [font-size:11px] [color:#7d9165] mb-[30px]">
                      <span>
                        Reading version {revision.version} ·{" "}
                        {formatDate(revision.createdAt)}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        className="text-link h-auto justify-start inline-flex items-center gap-[7px] p-[0] text-primary bg-transparent [font-size:12px] font-semibold text-left"
                        onClick={() => setRevision(null)}
                      >
                        Back to history
                      </Button>
                    </div>
                    <article className="markdown-body">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {revision.snapshot.markdown}
                      </ReactMarkdown>
                    </article>
                  </>
                ) : revisions.length ? (
                  <div className="revision-list">
                    {revisions.map((item) => (
                      <Button
                        type="button"
                        variant="ghost"
                        className="revision-row h-auto whitespace-normal flex items-center gap-[17px] w-full text-left bg-transparent p-[20px_6px] [border-bottom:1px_solid_var(--line)]!"
                        key={item.id}
                        onClick={() => setRevision(item)}
                      >
                        <span className="version-number [background:#e8eede] [color:#82966b] rounded-[5px] p-[6px_9px] [font-size:10px] [font-family:var(--mono)]">
                          v{item.version}
                        </span>
                        <div>
                          <strong>{item.reason || "Page saved"}</strong>
                          <p>
                            {item.source || "Workspace"} ·{" "}
                            {formatDate(item.createdAt)}
                          </p>
                        </div>
                        <ArrowUpRight size={17} />
                      </Button>
                    ))}
                  </div>
                ) : (
                  <Empty
                    icon={<Clock3 size={27} />}
                    title="The first chapter."
                    description="Saved versions will appear here as this page evolves."
                  />
                )}
              </TabsContent>
            </Tabs>
          </>
        )
      )}
    </div>
  );
}
