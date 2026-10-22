"use client";

import { BookmarkPlus, ChevronDown, Search, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useLayoutEffect, useState, useTransition } from "react";
import { saveViewAction } from "@/app/(workspace)/actions/tasks";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type TaskPriority,
  type TaskStatus,
} from "@/lib/tasks/types";
import {
  parseTaskListFilters,
  savedViewQuery,
  type TaskListFilters,
  taskListHref,
} from "@/lib/workspace/task-urls";
import { ActionError, useTaskAction } from "./action-state";
import { priorityLabel, STATUS_LABELS } from "./labels";

function toggle<T>(values: T[], value: T, on: boolean): T[] {
  return on ? [...values, value] : values.filter((item) => item !== value);
}

function SaveView({ filters }: { filters: TaskListFilters }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const { pending, error, run } = useTaskAction();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <BookmarkPlus aria-hidden="true" /> Save view
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return;
            run(
              () => saveViewAction(name.trim(), savedViewQuery(filters)),
              () => {
                setOpen(false);
                setName("");
              },
            );
          }}
        >
          <label htmlFor="saved-view-name" className="text-sm font-medium">
            Name this view
          </label>
          <Input
            id="saved-view-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            placeholder="e.g. Urgent client work"
            required
          />
          <p className="text-xs text-muted-foreground">
            Saving a name again replaces that view. Views appear in the sidebar.
          </p>
          <Button type="submit" size="sm" disabled={pending || !name.trim()}>
            {pending && <Spinner aria-hidden="true" />}
            Save
          </Button>
          <ActionError error={error} />
        </form>
      </PopoverContent>
    </Popover>
  );
}

/** Search, status, priority and agent filters for the /tasks table. */
export function TaskFilters({
  agents,
  projectTitle,
}: {
  agents: { id: string; label: string }[];
  projectTitle?: string | null;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const filters = parseTaskListFilters(params);
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState(filters.query);
  const search = params.toString();
  // Back/Forward and links replace an unsubmitted draft.
  useLayoutEffect(() => {
    setDraft(parseTaskListFilters(new URLSearchParams(search)).query);
  }, [search]);

  function navigate(changes: Partial<TaskListFilters>) {
    const href = taskListHref({
      ...filters,
      view: "overview",
      query: draft,
      offset: 0,
      ...changes,
    });
    startTransition(() => router.push(href, { scroll: false }));
  }

  const statusSummary = filters.statuses.length
    ? filters.statuses.map((status) => STATUS_LABELS[status]).join(", ")
    : "Open";
  const prioritySummary = filters.priorities.length
    ? filters.priorities.map(priorityLabel).join(", ")
    : "Any priority";

  return (
    <search className="mb-5" data-pending={pending}>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          navigate({ query: draft.trim() });
        }}
      >
        <div className="relative min-w-56 flex-1">
          <Search
            size={15}
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            aria-label="Search tasks"
            placeholder="Search titles, criteria, descriptions or T-42"
            value={draft}
            maxLength={200}
            onChange={(event) => setDraft(event.target.value)}
            className="pl-9"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" className="max-w-56">
              <span className="truncate">Status: {statusSummary}</span>
              <ChevronDown aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {TASK_STATUSES.map((status: TaskStatus) => (
              <DropdownMenuCheckboxItem
                key={status}
                checked={filters.statuses.includes(status)}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(checked) =>
                  navigate({
                    statuses: toggle(
                      filters.statuses,
                      status,
                      checked === true,
                    ),
                  })
                }
              >
                {STATUS_LABELS[status]}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" className="max-w-48">
              <span className="truncate">{prioritySummary}</span>
              <ChevronDown aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {TASK_PRIORITIES.map((priority: TaskPriority) => (
              <DropdownMenuCheckboxItem
                key={priority}
                checked={filters.priorities.includes(priority)}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(checked) =>
                  navigate({
                    priorities: toggle(
                      filters.priorities,
                      priority,
                      checked === true,
                    ),
                  })
                }
              >
                {priorityLabel(priority)}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {agents.length > 0 && (
          <div className="w-48">
            <NativeSelect
              aria-label="Agent"
              value={filters.agentId}
              onChange={(event) => navigate({ agentId: event.target.value })}
            >
              <NativeSelectOption value="">Any agent</NativeSelectOption>
              {agents.map((agent) => (
                <NativeSelectOption key={agent.id} value={agent.id}>
                  {agent.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        )}
        <Button
          type="button"
          variant={filters.archived ? "secondary" : "ghost"}
          aria-pressed={filters.archived}
          onClick={() => navigate({ archived: !filters.archived })}
        >
          Archived
        </Button>
        <Button type="submit" variant="secondary">
          {pending && <Spinner aria-hidden="true" />}
          Search
        </Button>
        <SaveView filters={filters} />
      </form>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {filters.projectId && (
          <Button variant="outline" size="xs" asChild>
            <Link href={taskListHref({ ...filters, projectId: "", offset: 0 })}>
              Project: {projectTitle ?? "selected project"}
              <X aria-hidden="true" />
            </Link>
          </Button>
        )}
        <Link href="/tasks" className="hover:text-foreground">
          Clear filters
        </Link>
      </div>
    </search>
  );
}
