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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  type ConnectionChoice,
  type ConnectionChoices,
  ConnectionPicker,
} from "./connection-picker";

const MarkdownPreview = dynamic(() => import("./markdown-preview"), {
  loading: () => (
    <output className="block text-sm text-muted-foreground">
      Loading preview…
    </output>
  ),
});
type DraftLink = {
  targetRef: string;
  type: LinkType;
  label: string;
  targetTitle?: string;
};

export function PageEditor({
  initialPage,
  initialType = "note",
  choices,
}: {
  initialPage: BrainPage | null;
  initialType?: PageType;
  choices: ConnectionChoices;
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
      targetTitle: link.targetTitle,
    })) ?? [],
  );
  const [linkTarget, setLinkTarget] = useState<ConnectionChoice | null>(null);
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
        targetTitle: link.targetTitle,
      })) ?? [],
    );
    setLinkTarget(null);
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
      className="grid gap-6"
    >
      <input type="hidden" name="id" value={id ?? ""} />
      <input type="hidden" name="expectedVersion" value={page?.version ?? 0} />
      <input
        type="hidden"
        name="links"
        value={JSON.stringify(
          links.map(({ targetRef, type, label }) => ({
            targetRef,
            type,
            label,
          })),
        )}
      />
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" asChild>
          <Link
            href={id ? `/pages/${id}` : "/"}
            onNavigate={() => {
              resetDraft(page);
              startTransition(() => formAction("reset"));
            }}
          >
            Cancel
          </Link>
        </Button>
        <Button type="submit" disabled={saving || loadingLatest}>
          {saving ? (
            <LoaderCircle size={16} className="animate-spin" />
          ) : (
            <Save size={16} />
          )}{" "}
          Save page
        </Button>
      </div>
      {error && (
        <Alert variant={conflict ? "default" : "destructive"}>
          <AlertTitle>{conflict ? "Page changed" : "Page notice"}</AlertTitle>
          <AlertDescription className="wrap-anywhere">
            <p>{error}</p>
            {conflict && (
              <>
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
              </>
            )}
          </AlertDescription>
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Label className="grid gap-2">
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
        <Label className="grid gap-2">
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
        <Alert>
          <AlertTitle>A page may already exist.</AlertTitle>
          <AlertDescription className="wrap-anywhere">
            <p>Read a possible match before creating another entity.</p>
            {duplicates.map((match) => (
              <Button
                type="button"
                variant="link"
                key={match.id}
                className="max-w-full"
                asChild
              >
                <Link href={`/pages/${match.id}`} title={match.title}>
                  <span className="truncate">{match.title}</span>
                  <ArrowUpRight size={14} />
                </Link>
              </Button>
            ))}
          </AlertDescription>
        </Alert>
      )}
      <Label className="grid gap-2">
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
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label htmlFor="markdown-content">Page content</Label>
          <TabsList>
            <TabsTrigger value="write">Write</TabsTrigger>
            <TabsTrigger value="preview">Preview</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent
          value="preview"
          className="markdown-body min-h-96 rounded-md border p-6"
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
            className="min-h-96 resize-y font-mono"
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            placeholder={
              "## Overview\n\nWhat is useful to remember?\n\n## Context\n\nAdd facts, sources, and the decisions behind them."
            }
            required
          />
        </TabsContent>
      </Tabs>
      <div className="grid gap-4 sm:grid-cols-2">
        <Label className="grid gap-2">
          Aliases
          <Input
            name="aliases"
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder="Other names, separated by commas"
          />
        </Label>
        <Label className="grid gap-2">
          Tags
          <Input
            name="tags"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="Tags, separated by commas"
          />
        </Label>
      </div>
      <div className="space-y-4 border-y py-6">
        <h3 className="flex items-center gap-2 font-medium">
          <Link2 size={16} /> Connections
        </h3>
        <p className="text-sm text-muted-foreground">
          Give every relationship a meaning.
        </p>
        {links.map((link, index) => (
          <div
            className="flex items-center gap-3 border-b pb-4 text-sm"
            key={`${link.targetRef}-${link.type}`}
          >
            <span className="text-muted-foreground">
              {link.type.replaceAll("_", " ")}
            </span>
            <strong className="min-w-0 wrap-anywhere">
              {link.targetTitle ||
                choices.pages.find((p) => p.id === link.targetRef)?.title ||
                page?.links.find((l) => l.targetId === link.targetRef)
                  ?.targetTitle ||
                link.targetRef}
            </strong>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="ml-auto shrink-0"
              aria-label="Remove connection"
              onClick={() => setLinks(links.filter((_, i) => i !== index))}
            >
              <X size={15} />
            </Button>
          </div>
        ))}
        <div className="flex flex-col items-stretch gap-4 lg:flex-row lg:items-start">
          <Label className="grid gap-2">
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
          <ConnectionPicker
            initialChoices={choices}
            excludeId={id}
            value={linkTarget}
            onChange={setLinkTarget}
          />
          <Button
            type="button"
            variant="outline"
            disabled={
              !linkTarget ||
              links.some(
                (link) =>
                  link.targetRef === linkTarget?.id && link.type === linkType,
              )
            }
            onClick={() => {
              if (!linkTarget) return;
              setLinks([
                ...links,
                {
                  targetRef: linkTarget.id,
                  targetTitle: linkTarget.title,
                  type: linkType,
                  label: "",
                },
              ]);
              setLinkTarget(null);
            }}
          >
            <Plus size={15} /> Add
          </Button>
        </div>
      </div>
      <Label className="grid gap-2">
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
        <details className="space-y-4 rounded-lg border bg-muted p-4">
          <summary className="cursor-pointer font-medium">
            Current saved version ({page.version})
          </summary>
          <div className="markdown-body">
            <MarkdownPreview markdown={page.markdown} />
          </div>
        </details>
      )}
      <div className="flex flex-wrap items-center justify-between gap-4 border-t pt-6">
        <span className="text-sm text-muted-foreground">
          Markdown supported · Changes are versioned
        </span>
        <Button
          type="submit"
          variant="default"
          disabled={saving || loadingLatest}
        >
          <Save size={16} /> Save page
        </Button>
      </div>
    </form>
  );
}
