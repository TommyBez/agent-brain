"use client";

import { Bookmark, X } from "lucide-react";
import Link from "next/link";
import { deleteViewAction } from "@/app/(workspace)/actions/tasks";
import { Button } from "@/components/ui/button";
import type { SavedTaskView } from "@/lib/tasks/settings";
import { savedViewHref } from "@/lib/workspace/task-urls";
import { ActionError, useTaskAction } from "./action-state";

function SavedViewChip({ view }: { view: SavedTaskView }) {
  const { pending, error, run } = useTaskAction();
  return (
    <li className="flex items-center rounded-full border bg-card text-xs has-data-pending:opacity-50">
      <Link
        href={savedViewHref(view.query)}
        className="flex items-center gap-1.5 py-1 pr-1 pl-3 hover:text-foreground"
      >
        <Bookmark size={12} aria-hidden="true" />
        {view.name}
      </Link>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="mr-1 rounded-full"
        aria-label={`Delete the view ${view.name}`}
        disabled={pending}
        data-pending={pending ? "" : undefined}
        onClick={() => run(() => deleteViewAction(view.id))}
      >
        <X />
      </Button>
      <ActionError error={error} className="px-2" />
    </li>
  );
}

/** Named URL filters, stored in the owner's task settings. */
export function SavedViews({ views }: { views: SavedTaskView[] }) {
  if (!views.length) return null;
  return (
    <nav aria-label="Saved views" className="mb-5">
      <ul className="flex flex-wrap gap-2">
        {views.map((view) => (
          <SavedViewChip key={view.id} view={view} />
        ))}
      </ul>
    </nav>
  );
}
