"use client";

import { Check, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { decideSuggestionAction } from "@/app/(workspace)/actions/tasks";
import type { SuggestionView } from "@/lib/workspace/task-queries";
import { taskHref } from "@/lib/workspace/task-urls";
import { pageHref } from "@/lib/workspace/urls";
import { ActionButton } from "./action-state";
import { suggestionLabel } from "./labels";
import { suggestedTransition } from "./transitions";

const ACCEPT_LABEL = {
  close: "Accept and mark done",
  cancel: "Accept and cancel the task",
  release: "Accept and release the claim",
  hold: "Accept and put on hold",
  link: "Accept and link the page",
} as const;

/** A task keeper suggestion: never applied until the owner accepts it. */
export function SuggestionCard({
  suggestion,
  showTask = true,
}: {
  suggestion: SuggestionView;
  showTask?: boolean;
}) {
  const transition = suggestedTransition({
    kind: suggestion.kind,
    payload: suggestion.payload,
    citations: suggestion.rawCitations,
  });
  return (
    <article className="space-y-3 rounded-xl border bg-card p-4">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <Sparkles
          size={15}
          aria-hidden="true"
          className="text-muted-foreground"
        />
        <h3 className="font-medium">{suggestionLabel(suggestion.kind)}</h3>
        {suggestion.confidence !== null && (
          <span className="text-xs text-muted-foreground tabular-nums">
            · {suggestion.confidence.toFixed(2)}
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          · {suggestion.suggestedBy}
        </span>
      </header>
      {showTask && (
        <p className="text-sm wrap-anywhere">
          <Link
            href={taskHref(suggestion.task.ref)}
            className="hover:underline"
          >
            <span className="font-mono text-xs text-muted-foreground">
              {suggestion.task.ref}
            </span>{" "}
            {suggestion.task.title.value}
          </Link>
          {suggestion.relatedRef && (
            <>
              {" "}
              and{" "}
              <Link
                href={taskHref(suggestion.relatedRef)}
                className="font-mono text-xs hover:underline"
              >
                {suggestion.relatedRef}
              </Link>
            </>
          )}
        </p>
      )}
      {suggestion.citations.length > 0 && (
        <ul className="space-y-2">
          {suggestion.citations.map((citation) => (
            <li
              key={`${citation.pageId}:${citation.version}:${citation.excerpt?.slice(0, 80)}`}
              className="space-y-1 text-sm"
            >
              {citation.excerpt && (
                <blockquote className="border-l-2 pl-3 whitespace-pre-wrap text-muted-foreground wrap-anywhere">
                  {citation.excerpt}
                </blockquote>
              )}
              {citation.pageId && (
                <Link
                  href={pageHref(citation.pageId)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  {citation.title}
                  {citation.version ? ` · version ${citation.version}` : ""}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <ActionButton
          size="sm"
          variant="outline"
          errorClassName="basis-full"
          action={() =>
            decideSuggestionAction(suggestion.id, "accepted", {
              version: suggestion.task.version,
              status: suggestion.task.status,
              claimCount: suggestion.task.claimCount,
            })
          }
        >
          <Check aria-hidden="true" />
          {transition ? ACCEPT_LABEL[transition.op] : "Accept"}
        </ActionButton>
        <ActionButton
          size="sm"
          variant="ghost"
          errorClassName="basis-full"
          action={() => decideSuggestionAction(suggestion.id, "dismissed")}
        >
          <X aria-hidden="true" /> Dismiss
        </ActionButton>
        {!transition && (
          <span className="text-xs text-muted-foreground">
            Accepting records your decision; make the change on the task.
          </span>
        )}
      </div>
    </article>
  );
}
