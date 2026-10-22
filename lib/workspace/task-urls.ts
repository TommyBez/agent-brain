import {
  addDays,
  endOfMonth,
  endOfWeek,
  format,
  isValid,
  parseISO,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import {
  parseTaskRef,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type TaskPriority,
  type TaskStatus,
} from "@/lib/tasks/types";

// URL state of the task views. Every parser accepts untrusted query strings
// and returns a canonical value; every href helper writes the canonical form,
// so saved views and links compare equal when they show the same thing.

export type TaskSearchParams = { get(name: string): string | null };

export const TASK_SORTS = [
  "priority",
  "due",
  "updated",
  "created",
  "number",
] as const;
export type TaskSort = (typeof TASK_SORTS)[number];
export type SortDirection = "asc" | "desc";
export const DEFAULT_SORT_DIRECTION: Record<TaskSort, SortDirection> = {
  priority: "asc",
  due: "asc",
  updated: "desc",
  created: "desc",
  number: "desc",
};

export const TASK_TABLE_PAGE_SIZE = 50;
export const TASK_QUERY_MAX = 200;
const MAX_OFFSET = 100_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TaskPageView = "overview" | "needs-you";

export interface TaskListFilters {
  view: TaskPageView;
  statuses: TaskStatus[];
  query: string;
  projectId: string;
  priorities: TaskPriority[];
  /** Claimed by, or delegated to, this agent. */
  agentId: string;
  archived: boolean;
  sort: TaskSort;
  direction: SortDirection;
  offset: number;
}

export const DEFAULT_TASK_LIST_FILTERS: TaskListFilters = {
  view: "overview",
  statuses: [],
  query: "",
  projectId: "",
  priorities: [],
  agentId: "",
  archived: false,
  sort: "priority",
  direction: "asc",
  offset: 0,
};

const uuid = (value: string | null) =>
  value && UUID.test(value.trim()) ? value.trim().toLowerCase() : "";

function list<T>(
  value: string | null,
  allowed: readonly T[],
  read: (item: string) => T,
): T[] {
  if (!value) return [];
  const wanted = new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map(read),
  );
  // Canonical order is the vocabulary order, never the order in the URL.
  return allowed.filter((item) => wanted.has(item));
}

export function parseOffset(value: string | null): number {
  const offset = value ? Number(value) : 0;
  return Number.isSafeInteger(offset) && offset > 0
    ? Math.min(offset, MAX_OFFSET)
    : 0;
}

export function parseTaskListFilters(
  params: TaskSearchParams,
): TaskListFilters {
  const sortValue = params.get("sort");
  const sort = (TASK_SORTS as readonly string[]).includes(sortValue ?? "")
    ? (sortValue as TaskSort)
    : "priority";
  const dir = params.get("dir");
  return {
    view: params.get("view") === "needs-you" ? "needs-you" : "overview",
    statuses: list(params.get("status"), TASK_STATUSES, (item) =>
      item.toLowerCase(),
    ) as TaskStatus[],
    query: (params.get("q") ?? "").trim().slice(0, TASK_QUERY_MAX),
    projectId: uuid(params.get("project")),
    priorities: list(params.get("priority"), TASK_PRIORITIES, (item) =>
      Number(item),
    ) as TaskPriority[],
    agentId: uuid(params.get("agent")),
    archived: params.get("archived") === "1",
    sort,
    direction:
      dir === "asc" || dir === "desc" ? dir : DEFAULT_SORT_DIRECTION[sort],
    offset: parseOffset(params.get("offset")),
  };
}

function listParams(filters: Partial<TaskListFilters>): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.statuses?.length)
    params.set(
      "status",
      TASK_STATUSES.filter((status) => filters.statuses?.includes(status)).join(
        ",",
      ),
    );
  const query = filters.query?.trim().slice(0, TASK_QUERY_MAX);
  if (query) params.set("q", query);
  if (filters.projectId && UUID.test(filters.projectId))
    params.set("project", filters.projectId.toLowerCase());
  if (filters.priorities?.length)
    params.set(
      "priority",
      TASK_PRIORITIES.filter((priority) =>
        filters.priorities?.includes(priority),
      ).join(","),
    );
  if (filters.agentId && UUID.test(filters.agentId))
    params.set("agent", filters.agentId.toLowerCase());
  if (filters.archived) params.set("archived", "1");
  const sort = filters.sort ?? "priority";
  if (sort !== "priority") params.set("sort", sort);
  if (filters.direction && filters.direction !== DEFAULT_SORT_DIRECTION[sort])
    params.set("dir", filters.direction);
  return params;
}

/** `/tasks` with filters, sort and pagination in canonical order. */
export function taskListHref(filters: Partial<TaskListFilters> = {}): string {
  const params = new URLSearchParams();
  if (filters.view === "needs-you") params.set("view", "needs-you");
  for (const [key, value] of listParams(filters)) params.set(key, value);
  if (filters.offset && filters.offset > 0)
    params.set("offset", String(Math.min(filters.offset, MAX_OFFSET)));
  return params.size ? `/tasks?${params}` : "/tasks";
}

/** The overview shows Needs you and the open sections; any filter shows one table. */
export function isFilteredTaskList(filters: TaskListFilters): boolean {
  return (
    filters.view === "overview" &&
    (listParams(filters).size > 0 || filters.offset > 0)
  );
}

/** A saved view stores this canonical query: filters and sort, never the page. */
export function savedViewQuery(filters: Partial<TaskListFilters>): string {
  return listParams(filters).toString();
}

/** A stored query is re-parsed, so a tampered value can only select valid filters. */
export function savedViewHref(query: string): string {
  const filters = parseTaskListFilters(
    new URLSearchParams(query.replace(/^\?/, "")),
  );
  return taskListHref({ ...filters, view: "overview", offset: 0 });
}

export function nextSort(
  filters: TaskListFilters,
  sort: TaskSort,
): Pick<TaskListFilters, "sort" | "direction"> {
  if (filters.sort !== sort)
    return { sort, direction: DEFAULT_SORT_DIRECTION[sort] };
  return { sort, direction: filters.direction === "asc" ? "desc" : "asc" };
}

/** Anchors the agents' owner_action links point at. */
export type TaskAnchor =
  | "approve"
  | "answer"
  | "review"
  | "unblock"
  | "delegate"
  | "revoke"
  | "edit"
  | "activity";

/** `T-42` stays readable; anything else is encoded. */
export function taskHref(ref: string, anchor?: TaskAnchor): string {
  const parsed = parseTaskRef(ref);
  const segment =
    parsed?.kind === "number"
      ? `T-${parsed.number}`
      : encodeURIComponent(ref.trim());
  return `/tasks/${segment}${anchor ? `#${anchor}` : ""}`;
}

export function taskEditHref(ref: string): string {
  return `${taskHref(ref)}/edit`;
}

/** Canonical reference from a route parameter, or null when it is not a task reference. */
export function canonicalTaskRef(param: string): string | null {
  const parsed = parseTaskRef(decodeURIComponent(param));
  if (!parsed) return null;
  return parsed.kind === "number" ? `T-${parsed.number}` : parsed.id;
}

export function newTaskHref(options: { projectId?: string } = {}): string {
  return options.projectId && UUID.test(options.projectId)
    ? `/tasks/new?project=${options.projectId.toLowerCase()}`
    : "/tasks/new";
}

export function parseNewTaskParams(params: TaskSearchParams): {
  projectId: string;
} {
  return { projectId: uuid(params.get("project")) };
}

export interface TaskBoardFilters {
  projectId: string;
  query: string;
}

export function parseTaskBoardFilters(
  params: TaskSearchParams,
): TaskBoardFilters {
  return {
    projectId: uuid(params.get("project")),
    query: (params.get("q") ?? "").trim().slice(0, TASK_QUERY_MAX),
  };
}

export function taskBoardHref(filters: Partial<TaskBoardFilters> = {}): string {
  const params = new URLSearchParams();
  if (filters.projectId && UUID.test(filters.projectId))
    params.set("project", filters.projectId.toLowerCase());
  const query = filters.query?.trim().slice(0, TASK_QUERY_MAX);
  if (query) params.set("q", query);
  return params.size ? `/tasks/board?${params}` : "/tasks/board";
}

export type CalendarMode = "month" | "week";
export interface TaskCalendarState {
  mode: CalendarMode;
  /** YYYY-MM-DD, or null for "today" as the browser sees it. */
  date: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string | null | undefined): value is string {
  if (!value || !ISO_DATE.test(value)) return false;
  const date = parseISO(value);
  return isValid(date) && format(date, "yyyy-MM-dd") === value;
}

export function parseTaskCalendar(params: TaskSearchParams): TaskCalendarState {
  const date = params.get("date");
  return {
    mode: params.get("mode") === "week" ? "week" : "month",
    date: isIsoDate(date) ? date : null,
  };
}

export function taskCalendarHref(state: Partial<TaskCalendarState> = {}) {
  const params = new URLSearchParams();
  if (state.mode === "week") params.set("mode", "week");
  if (isIsoDate(state.date)) params.set("date", state.date);
  return params.size ? `/tasks/calendar?${params}` : "/tasks/calendar";
}

/** The days a calendar view shows: whole weeks, Monday first. */
export function calendarRange(
  mode: CalendarMode,
  date: string,
): { from: string; to: string; days: string[] } {
  const anchor = parseISO(date);
  const start =
    mode === "week"
      ? startOfWeek(anchor, { weekStartsOn: 1 })
      : startOfWeek(startOfMonth(anchor), { weekStartsOn: 1 });
  const end =
    mode === "week"
      ? endOfWeek(anchor, { weekStartsOn: 1 })
      : endOfWeek(endOfMonth(anchor), { weekStartsOn: 1 });
  const days: string[] = [];
  for (let day = start; day <= end; day = addDays(day, 1))
    days.push(format(day, "yyyy-MM-dd"));
  return { from: days[0], to: days[days.length - 1], days };
}

/**
 * The days the server loads. Without a date the browser picks "today", which
 * may be a day away from the server's, so the window spans the neighbouring
 * month or week as well.
 */
export function calendarFetchWindow(
  state: TaskCalendarState,
  serverToday: string,
): { from: string; to: string } {
  const range = calendarRange(state.mode, state.date ?? serverToday);
  const margin = state.date ? 0 : state.mode === "week" ? 7 : 35;
  return {
    from: format(addDays(parseISO(range.from), -margin), "yyyy-MM-dd"),
    to: format(addDays(parseISO(range.to), margin), "yyyy-MM-dd"),
  };
}
