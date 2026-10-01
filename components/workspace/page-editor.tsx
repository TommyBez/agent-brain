"use client";

import { ArrowUpRight, ChevronDown, Save } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  startTransition,
  useActionState,
  useId,
  useState,
  useTransition,
} from "react";
import {
  readLatestPageAction,
  savePageAction,
} from "@/app/(workspace)/actions/pages";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { entityTypes } from "@/lib/brain/labels";
import {
  type DecoratedPage,
  isPageType,
  type PageType,
} from "@/lib/brain/types";
import { draftFromPage, type PageDraft } from "@/lib/workspace/page-draft";
import type { ConnectionChoices } from "./connection-picker";
import { ConnectionsEditor } from "./connections-editor";
import { MarkdownField, MarkdownPreview } from "./markdown-field";
import { useDuplicateCheck } from "./use-duplicate-check";

export function PageEditor({
  initialPage,
  initialType = "note",
  choices,
}: {
  initialPage: DecoratedPage | null;
  initialType?: PageType;
  choices: ConnectionChoices;
}) {
  const router = useRouter();
  const fieldId = useId();
  const [page, setPage] = useState(initialPage);
  const id = initialPage?.id;
  const [draft, setDraft] = useState(() =>
    draftFromPage(initialPage, initialType),
  );
  const { title, type, summary, markdown, aliases, tags, reason, links } =
    draft;
  function updateDraft<K extends keyof PageDraft>(key: K, value: PageDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }
  const [connectionsEpoch, setConnectionsEpoch] = useState(0);
  const {
    duplicates,
    error: duplicateError,
    reset: resetDuplicates,
  } = useDuplicateCheck(title, type, !id);
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
  const conflict =
    state.code === "VERSION_CONFLICT" &&
    state.expectedVersion === page?.version;
  const error = notice || state.message || duplicateError;

  function resetDraft(current: DecoratedPage | null) {
    resetDuplicates();
    setDraft(draftFromPage(current, initialType));
    setConnectionsEpoch((epoch) => epoch + 1);
    setComparison(false);
    setNotice("");
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
      onReset={(event) => event.preventDefault()}
      className="mx-auto grid max-w-4xl gap-7"
    >
      <input type="hidden" name="id" value={id ?? ""} />
      <input type="hidden" name="expectedVersion" value={page?.version ?? 0} />
      <div className="flex items-center justify-end gap-2 border-b pb-5">
        <h1 className="mr-auto text-sm font-medium">
          {id ? "Edit page" : "New page"}
        </h1>
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
          {saving ? <Spinner aria-hidden="true" /> : <Save size={16} />}
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
      <FieldGroup className="gap-5 sm:grid sm:grid-cols-[minmax(0,1fr)_12rem]">
        <Field>
          <FieldLabel htmlFor={`${fieldId}-title`}>Title</FieldLabel>
          <Input
            id={`${fieldId}-title`}
            value={title}
            name="title"
            className="h-16 rounded-none border-0 border-b bg-transparent px-0 font-serif text-3xl font-normal shadow-none md:text-4xl"
            onChange={(e) => {
              updateDraft("title", e.target.value);
            }}
            placeholder="Untitled page"
            maxLength={200}
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${fieldId}-type`}>Page type</FieldLabel>
          <NativeSelect
            id={`${fieldId}-type`}
            className="h-16 border-0 bg-transparent shadow-none"
            value={type}
            name="type"
            onChange={(e) => {
              const next = e.target.value;
              if (!isPageType(next)) return;
              updateDraft("type", next);
            }}
          >
            {entityTypes.map((item) => (
              <NativeSelectOption key={item.id} value={item.id}>
                {item.singular}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </FieldGroup>
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
      <Field>
        <FieldLabel htmlFor={`${fieldId}-summary`}>Summary</FieldLabel>
        <Input
          id={`${fieldId}-summary`}
          name="summary"
          className="rounded-none border-0 border-b bg-transparent px-0 shadow-none"
          value={summary}
          onChange={(e) => updateDraft("summary", e.target.value)}
          maxLength={2000}
          placeholder="A sentence that captures what this page is about."
        />
      </Field>
      <MarkdownField
        key={connectionsEpoch}
        markdown={markdown}
        onChange={(value) => updateDraft("markdown", value)}
      />
      <Collapsible className="border-y py-5">
        <CollapsibleTrigger className="group/trigger flex w-full items-center justify-between text-sm font-medium">
          Connections & metadata
          <ChevronDown
            size={16}
            className="text-muted-foreground transition-transform group-data-open/trigger:rotate-180"
          />
        </CollapsibleTrigger>
        {/* Collapsed fields stay mounted (hidden) so the form still submits them. */}
        <CollapsibleContent
          forceMount
          className="mt-6 grid gap-7 data-closed:hidden"
        >
          <FieldGroup className="gap-4 sm:grid sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`${fieldId}-aliases`}>Aliases</FieldLabel>
              <Input
                id={`${fieldId}-aliases`}
                name="aliases"
                value={aliases}
                onChange={(e) => updateDraft("aliases", e.target.value)}
                placeholder="Other names, separated by commas"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${fieldId}-tags`}>Tags</FieldLabel>
              <Input
                id={`${fieldId}-tags`}
                name="tags"
                value={tags}
                onChange={(e) => updateDraft("tags", e.target.value)}
                placeholder="Tags, separated by commas"
              />
            </Field>
          </FieldGroup>
          <ConnectionsEditor
            key={connectionsEpoch}
            links={links}
            onChange={(links) => updateDraft("links", links)}
            choices={choices}
            id={id}
          />
          <Field>
            <FieldLabel htmlFor={`${fieldId}-reason`}>
              Reason for this change
            </FieldLabel>
            <Input
              id={`${fieldId}-reason`}
              name="reason"
              value={reason}
              onChange={(e) => updateDraft("reason", e.target.value)}
              placeholder="What changed, and why?"
              maxLength={1000}
            />
          </Field>
        </CollapsibleContent>
      </Collapsible>
      {comparison && page && (
        <Collapsible className="rounded-lg border bg-muted p-4">
          <CollapsibleTrigger className="group/trigger flex w-full items-center justify-between font-medium">
            Current saved version ({page.version})
            <ChevronDown
              size={16}
              className="text-muted-foreground transition-transform group-data-open/trigger:rotate-180"
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="markdown-body mt-4">
            <MarkdownPreview markdown={page.markdown} />
          </CollapsibleContent>
        </Collapsible>
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
