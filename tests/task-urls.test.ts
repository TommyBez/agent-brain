import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarFetchWindow,
  calendarRange,
  canonicalTaskRef,
  isFilteredTaskList,
  isIsoDate,
  newTaskHref,
  nextSort,
  parseNewTaskParams,
  parseTaskBoardFilters,
  parseTaskCalendar,
  parseTaskListFilters,
  savedViewHref,
  savedViewQuery,
  taskBoardHref,
  taskCalendarHref,
  taskEditHref,
  taskHref,
  taskListHref,
} from "../lib/workspace/task-urls";

const PROJECT = "0b6f1c58-3a43-4c47-9b49-6a1f3c3d2e10";
const AGENT = "5e1d8c4a-2f90-4b7e-8f22-41a6c2c1b0d9";

const parse = (query: string) =>
  parseTaskListFilters(new URLSearchParams(query));

test("task list filters parse untrusted input into canonical values", () => {
  assert.deepEqual(parse(""), {
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
  });
  const filters = parse(
    `status=canceled,done,bogus,DONE&q=${" x".repeat(150)}&project=${PROJECT.toUpperCase()}&priority=3,0,9,a&agent=nope&archived=1&sort=due&dir=sideways&offset=-5`,
  );
  // Vocabulary order, deduplicated; unknown values are dropped.
  assert.deepEqual(filters.statuses, ["done", "canceled"]);
  assert.deepEqual(filters.priorities, [0, 3]);
  assert.equal(filters.query.length, 200);
  assert.equal(filters.projectId, PROJECT);
  assert.equal(filters.agentId, "");
  assert.equal(filters.archived, true);
  assert.equal(filters.sort, "due");
  assert.equal(filters.direction, "asc");
  assert.equal(filters.offset, 0);
  assert.equal(parse("offset=999999999").offset, 100_000);
  assert.equal(parse("sort=updated").direction, "desc");
  assert.equal(parse("sort=priority&dir=desc").direction, "desc");
  assert.equal(parse("view=needs-you").view, "needs-you");
  assert.equal(parse("view=other").view, "overview");
});

test("task list hrefs are canonical and round-trip through the parser", () => {
  assert.equal(taskListHref(), "/tasks");
  assert.equal(taskListHref({ view: "needs-you" }), "/tasks?view=needs-you");
  const href = taskListHref({
    statuses: ["canceled", "done"],
    query: "  report AÜ.27 ",
    projectId: PROJECT,
    priorities: [1, 0],
    agentId: AGENT,
    archived: true,
    sort: "updated",
    direction: "desc",
    offset: 50,
  });
  const url = new URL(href, "https://brain.example");
  assert.equal(url.pathname, "/tasks");
  assert.deepEqual(
    [...url.searchParams.keys()],
    [
      "status",
      "q",
      "project",
      "priority",
      "agent",
      "archived",
      "sort",
      "offset",
    ],
  );
  assert.equal(url.searchParams.get("status"), "done,canceled");
  assert.equal(url.searchParams.get("q"), "report AÜ.27");
  assert.equal(url.searchParams.get("priority"), "0,1");
  // The default direction for the sort is omitted.
  assert.equal(url.searchParams.has("dir"), false);
  const parsed = parse(url.search);
  assert.equal(taskListHref(parsed), href);
  assert.equal(
    taskListHref({ sort: "priority", direction: "asc", offset: 0 }),
    "/tasks",
  );
  assert.equal(
    taskListHref({ sort: "due", direction: "desc" }),
    "/tasks?sort=due&dir=desc",
  );
  // Malformed ids never reach the URL.
  assert.equal(taskListHref({ projectId: "x' OR 1=1" }), "/tasks");
});

test("filters select the single table; the overview stays for no filters", () => {
  assert.equal(isFilteredTaskList(parse("")), false);
  assert.equal(isFilteredTaskList(parse("view=needs-you&q=x")), false);
  for (const query of [
    "status=done",
    "q=report",
    `project=${PROJECT}`,
    "priority=0",
    `agent=${AGENT}`,
    "archived=1",
    "sort=due",
    "dir=desc",
    "offset=50",
  ])
    assert.equal(isFilteredTaskList(parse(query)), true, query);
});

test("sorting toggles the direction of the active column only", () => {
  const filters = parse("sort=due");
  assert.deepEqual(nextSort(filters, "due"), {
    sort: "due",
    direction: "desc",
  });
  assert.deepEqual(nextSort(parse("sort=due&dir=desc"), "due"), {
    sort: "due",
    direction: "asc",
  });
  assert.deepEqual(nextSort(filters, "updated"), {
    sort: "updated",
    direction: "desc",
  });
});

test("saved views store filters without page or view, and re-parse on use", () => {
  const query = savedViewQuery({
    ...parse("status=ready&priority=0&offset=100&view=needs-you"),
  });
  assert.equal(query, "status=ready&priority=0");
  assert.equal(savedViewHref(query), "/tasks?status=ready&priority=0");
  assert.equal(savedViewHref(`?${query}`), "/tasks?status=ready&priority=0");
  // A tampered stored value can only select valid filters.
  assert.equal(
    savedViewHref("status=hacked&project=javascript:alert(1)&offset=50"),
    "/tasks",
  );
});

test("task references stay readable and parse from route parameters", () => {
  assert.equal(taskHref("T-42"), "/tasks/T-42");
  assert.equal(taskHref("t-42", "answer"), "/tasks/T-42#answer");
  assert.equal(taskEditHref("T-7"), "/tasks/T-7/edit");
  assert.equal(
    taskHref("0B6F1C58-3A43-4C47-9B49-6A1F3C3D2E10"),
    "/tasks/0B6F1C58-3A43-4C47-9B49-6A1F3C3D2E10",
  );
  assert.equal(canonicalTaskRef("t-42"), "T-42");
  assert.equal(canonicalTaskRef(PROJECT.toUpperCase()), PROJECT);
  assert.equal(canonicalTaskRef("T-0"), null);
  assert.equal(canonicalTaskRef("board"), null);
  assert.equal(canonicalTaskRef("T-99999999999"), null);
});

test("new-task and board links keep only a valid project", () => {
  assert.equal(newTaskHref(), "/tasks/new");
  assert.equal(
    newTaskHref({ projectId: PROJECT.toUpperCase() }),
    `/tasks/new?project=${PROJECT}`,
  );
  assert.equal(newTaskHref({ projectId: "nope" }), "/tasks/new");
  assert.deepEqual(
    parseNewTaskParams(new URLSearchParams(`project=${PROJECT}`)),
    { projectId: PROJECT },
  );
  assert.deepEqual(parseNewTaskParams(new URLSearchParams("project=../../x")), {
    projectId: "",
  });
  assert.equal(taskBoardHref(), "/tasks/board");
  const board = taskBoardHref({ projectId: PROJECT, query: " T-4 " });
  assert.equal(board, `/tasks/board?project=${PROJECT}&q=T-4`);
  assert.deepEqual(
    parseTaskBoardFilters(new URL(board, "https://brain.example").searchParams),
    { projectId: PROJECT, query: "T-4" },
  );
});

test("calendar state accepts real dates only and builds whole weeks", () => {
  assert.equal(isIsoDate("2026-10-21"), true);
  assert.equal(isIsoDate("2026-02-30"), false);
  assert.equal(isIsoDate("2026-1-5"), false);
  assert.deepEqual(parseTaskCalendar(new URLSearchParams("")), {
    mode: "month",
    date: null,
  });
  assert.deepEqual(
    parseTaskCalendar(new URLSearchParams("mode=week&date=2026-10-21")),
    { mode: "week", date: "2026-10-21" },
  );
  assert.deepEqual(
    parseTaskCalendar(new URLSearchParams("mode=year&date=yesterday")),
    { mode: "month", date: null },
  );
  assert.equal(taskCalendarHref(), "/tasks/calendar");
  assert.equal(
    taskCalendarHref({ mode: "week", date: "2026-10-19" }),
    "/tasks/calendar?mode=week&date=2026-10-19",
  );
  assert.equal(
    taskCalendarHref({ mode: "month", date: "bad" }),
    "/tasks/calendar",
  );

  const month = calendarRange("month", "2026-10-21");
  assert.equal(month.from, "2026-09-28");
  assert.equal(month.to, "2026-11-01");
  assert.equal(month.days.length % 7, 0);
  const week = calendarRange("week", "2026-10-25");
  assert.deepEqual([week.from, week.to], ["2026-10-19", "2026-10-25"]);
  // Daylight saving ends on 25 October; days are still whole days.
  assert.equal(week.days.length, 7);
});

test("the calendar window widens when the browser picks today", () => {
  assert.deepEqual(
    calendarFetchWindow({ mode: "month", date: "2026-10-21" }, "2030-01-01"),
    { from: "2026-09-28", to: "2026-11-01" },
  );
  const open = calendarFetchWindow({ mode: "month", date: null }, "2026-10-31");
  // The browser may already be in November.
  assert.ok(open.to >= "2026-11-30");
  assert.ok(open.from <= "2026-09-30");
  const weekly = calendarFetchWindow(
    { mode: "week", date: null },
    "2026-10-25",
  );
  assert.deepEqual(weekly, { from: "2026-10-12", to: "2026-11-01" });
});
