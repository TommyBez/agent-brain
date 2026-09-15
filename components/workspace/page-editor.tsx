"use client";

import { ArrowUpRight, Link2, LoaderCircle, Plus, Save, X } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  startTransition,
  useActionState,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import {
  readLatestPageAction,
  savePageAction,
} from "@/app/(workspace)/actions/pages";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type {
  BrainPage,
  LinkType,
  PageSummary,
  PageType,
} from "@/lib/brain/types";
import { entityTypes, linkTypes, request } from "../brain-types";

const MarkdownPreview = dynamic(() => import("./markdown-preview"), {
  loading: () => (
    <output className="block text-sm text-muted-foreground">
      Loading preview…
    </output>
  ),
});
type DraftLink = { targetRef: string; type: LinkType; label: string };

export function PageEditor({
  initialPage,
  initialType = "note",
  choices,
}: {
  initialPage: BrainPage | null;
  initialType?: PageType;
  choices: Pick<PageSummary, "id" | "title">[];
}) {
  const router = useRouter();
  const [page, setPage] = useState(initialPage);
  const id = initialPage?.id;
  const [title, setTitle] = useState(initialPage?.title ?? "");
  const [type, setType] = useState<PageType>(initialPage?.type ?? initialType);
  const [summary, setSummary] = useState(initialPage?.summary ?? "");
  const [markdown, setMarkdown] = useState(initialPage?.markdown ?? "");
  const [aliases, setAliases] = useState(initialPage?.aliases.join(", ") ?? "");
  const [tags, setTags] = useState(initialPage?.tags.join(", ") ?? "");
  const [reason, setReason] = useState("");
  const [links, setLinks] = useState<DraftLink[]>(
    initialPage?.links.map((link) => ({
      targetRef: link.targetId,
      type: link.type,
      label: link.label || "",
    })) ?? [],
  );
  const [linkTarget, setLinkTarget] = useState("");
  const [linkType, setLinkType] = useState<LinkType>("relates_to");
  const [preview, setPreview] = useState(false);
  const [duplicates, setDuplicates] = useState<PageSummary[]>([]);
  const [state, formAction, saving] = useActionState(
    async (
      previous: Parameters<typeof savePageAction>[0],
      form: FormData | "reset",
    ) => {
      if (form === "reset") return {};
      const result = await savePageAction(previous, form);
      if (result.savedPage) {
        if (id) setPage(result.savedPage);
        // Activity preserves routes. A completed new-page form must not reopen as a duplicate draft.
        resetDraft(id ? result.savedPage : null);
        router.push(`/pages/${result.savedPage.id}`);
      }
      return result;
    },
    {},
  );
  const [loadingLatest, startLatest] = useTransition();
  const [notice, setNotice] = useState("");
  const [comparison, setComparison] = useState(false);
  const resolveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resolveRequest = useRef<AbortController | null>(null);
  const conflict =
    state.code === "VERSION_CONFLICT" &&
    state.expectedVersion === page?.version;
  const error = notice || state.message;

  function resetDraft(current: BrainPage | null) {
    if (resolveTimer.current) clearTimeout(resolveTimer.current);
    resolveRequest.current?.abort();
    setTitle(current?.title ?? "");
    setType(current?.type ?? initialType);
    setSummary(current?.summary ?? "");
    setMarkdown(current?.markdown ?? "");
    setAliases(current?.aliases.join(", ") ?? "");
    setTags(current?.tags.join(", ") ?? "");
    setReason("");
    setLinks(
      current?.links.map((link) => ({
        targetRef: link.targetId,
        type: link.type,
        label: link.label || "",
      })) ?? [],
    );
    setLinkTarget("");
    setPreview(false);
    setDuplicates([]);
    setComparison(false);
    setNotice("");
  }

  // Clean up user-triggered lookups when Activity hides this editor, preserving the draft itself.
  useEffect(
    () => () => {
      if (resolveTimer.current) clearTimeout(resolveTimer.current);
      resolveRequest.current?.abort();
    },
    [],
  );

  function scheduleResolve(name: string, pageType: PageType) {
    if (id) return;
    if (resolveTimer.current) clearTimeout(resolveTimer.current);
    resolveRequest.current?.abort();
    setDuplicates([]);
    if (name.trim().length < 3) return;
    const controller = new AbortController();
    resolveRequest.current = controller;
    resolveTimer.current = setTimeout(async () => {
      try {
        const data = await request<{ candidates: PageSummary[] }>(
          `/api/brain/resolve?name=${encodeURIComponent(name)}&type=${pageType}`,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) setDuplicates(data.candidates);
      } catch (cause) {
        if (!controller.signal.aborted)
          setNotice(
            cause instanceof Error
              ? cause.message
              : "Unable to check for duplicate pages.",
          );
      }
    }, 300);
  }

  function loadLatest() {
    if (!id) return;
    startLatest(async () => {
      try {
        const current = await readLatestPageAction(id);
        setPage(current);
        setComparison(true);
        setNotice(
          "Latest version loaded for comparison. Your draft is still in the editor. Review the current page below, then save your reconciled changes.",
        );
      } catch {
        setNotice(
          "Unable to load the latest version. Your draft has been preserved.",
        );
      }
    });
  }

  return (
    <form
      action={formAction}
      onSubmit={() => setNotice("")}
      className="page-editor"
    >
      <input type="hidden" name="id" value={id ?? ""} />
      <input type="hidden" name="expectedVersion" value={page?.version ?? 0} />
      <input type="hidden" name="links" value={JSON.stringify(links)} />
      <div className="button-group flex justify-end gap-[10px] items-center mb-[30px]">
        <Button variant="outline" asChild>
          <Link
            href={id ? `/pages/${id}` : "/"}
            onClick={() => {
              resetDraft(page);
              startTransition(() => formAction("reset"));
            }}
          >
            Cancel
          </Link>
        </Button>
        <Button type="submit" disabled={saving || loadingLatest}>
          {saving ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <Save size={16} />
          )}{" "}
          Save page
        </Button>
      </div>
      {error && (
        <div
          className={`message border border-border bg-secondary p-4 rounded-md text-sm my-5 ${conflict ? "warning" : "error"}`}
          role="alert"
        >
          {error}
          {conflict && (
            <div>
              <p>
                Another writer saved this page. Your draft is preserved. Load
                the current version, compare it with your draft, and reconcile
                the changes.
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={loadLatest}
                disabled={saving || loadingLatest}
              >
                {loadingLatest
                  ? "Loading latest version…"
                  : "Load latest version"}
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
            name="title"
            onChange={(e) => {
              setTitle(e.target.value);
              scheduleResolve(e.target.value, type);
            }}
            placeholder="A person, a project, an idea…"
            maxLength={200}
            required
          />
        </Label>
        <Label>
          Page type
          <NativeSelect
            value={type}
            name="type"
            onChange={(e) => {
              const next = e.target.value as PageType;
              setType(next);
              scheduleResolve(title, next);
            }}
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
              asChild
            >
              <Link href={`/pages/${match.id}`}>
                {match.title}
                <ArrowUpRight size={14} />
              </Link>
            </Button>
          ))}
        </div>
      )}
      <Label>
        Summary
        <Input
          name="summary"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          maxLength={2000}
          placeholder="A sentence that captures what this page is about."
        />
      </Label>
      <input type="hidden" name="markdown" value={markdown} />
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
          {preview && (
            <MarkdownPreview
              markdown={
                markdown || "*Your page is waiting for its first words.*"
              }
            />
          )}
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
            name="aliases"
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder="Other names, separated by commas"
          />
        </Label>
        <Label>
          Tags
          <Input
            name="tags"
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
              <NativeSelectOption value="">Choose a page…</NativeSelectOption>
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
          name="reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="What changed, and why?"
          maxLength={1000}
        />
      </Label>
      {comparison && page && (
        <details className="latest-comparison m-[20px_0] p-5 [background:#f4f1e3] [border:1px_solid_#dfd6b6]">
          <summary>Current saved version ({page.version})</summary>
          <div className="markdown-body">
            <MarkdownPreview markdown={page.markdown} />
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
  );
}
