import assert from "node:assert/strict";
import type { TaskToolName } from "../../lib/tasks/tool-definitions";
import { formatTaskRef, parseTaskRef } from "../../lib/tasks/types";
import { type Trace, toolDefinitions } from "./brain";
import type { Scenario } from "./dataset";
import type { Bundle, Session } from "./evaluate";
import {
  type FakeTask,
  isTaskTool,
  type TaskWorld,
  taskToolDefinitions,
} from "./task-brain";

/** A task mutation the user's request authorizes; `ref: "new"` = a task created in the trial. */
export type ActionPattern = { tool: TaskToolName; ref?: string };
export type TaskExpectation = {
  /** Inclusive range of tasks the subject may create. */
  creates: [min: number, max: number];
  /** Authorized task mutations; reads are always allowed. */
  allowed: ActionPattern[];
  /** Page writes must follow a successful claim of this task. */
  workRef?: string;
  /** Whether the request is a literal owner request to take a task. */
  ownerRequest?: boolean;
  claims?: { ref: string; onOwnerRequest?: boolean }[];
  question?: string;
  completes?: string[];
  finalStatus?: Record<string, string[]>;
  ownerLink?: { url: string; unlessCompleted?: string };
  mentions?: string[];
  parentRef?: string;
  projectId?: string;
  allowedDue?: { kinds: string[]; on?: string }[];
  forbiddenPeople?: string[];
  criteriaInclude?: { ref: string; phrases: string[] };
};
export type TaskCase = { world: TaskWorld; expect: TaskExpectation };

const MUTATIONS = new Set<string>([
  "create_task",
  "update_task",
  "claim_task",
  "report_task",
  "release_task",
  "complete_task",
]);
const HOLDER_CALLS = new Set(["report_task", "release_task", "complete_task"]);
const fold = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[«»"“”'‘’.,;:!?()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const input = (t: Trace) => (t.input ?? {}) as Record<string, unknown>;
const code = (t: Trace) => t.error?.match(/^([A-Z_]+):/)?.[1] ?? null;
const ok = (t: Trace) => !t.error;

/** Canonical T-n for a ref given as T-n or a task id, using the trial's world. */
function canonical(world: TaskWorld, ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  const parsed = parseTaskRef(ref);
  if (!parsed) return null;
  if (parsed.kind === "number") return formatTaskRef(parsed.number);
  const task = world.tasks.find((t) => t.id === parsed.id);
  return task ? formatTaskRef(task.number) : null;
}
const outputRef = (t: Trace) =>
  ((t.output as { task?: { ref?: string } } | null)?.task?.ref ??
    (t.output as { ref?: string } | null)?.ref ??
    null) as string | null;

/** Structural checks of a task trial, on top of the page checks of `score`. */
export function scoreTasks(scenario: Scenario, session: Session) {
  assert(scenario.tasks && session.tasks && session.initialTasks);
  const { expect } = scenario.tasks;
  const world = session.tasks;
  const initial = session.initialTasks;
  const subject = world.subjectId;
  const trace = session.trace;
  const refAt = (t: Trace) => canonical(world, input(t).ref) ?? outputRef(t);
  const initialIds = new Set(initial.tasks.map((t) => t.id));
  const created = world.tasks.filter(
    (t) => !initialIds.has(t.id) && t.createdBy === subject,
  );
  const createdRefs = new Set(created.map((t) => formatTaskRef(t.number)));
  const byRef = (ref: string) =>
    world.tasks.find((t) => formatTaskRef(t.number) === ref);

  // Leases the subject received, and LEASE_HELD answers it got.
  const ownLeases = new Set<string>();
  const claimed: { index: number; ref: string; owner: boolean }[] = [];
  trace.forEach((t, index) => {
    if (t.tool !== "claim_task" || !ok(t)) return;
    const output = t.output as { leaseId?: string; task?: { ref?: string } };
    if (output.leaseId) ownLeases.add(output.leaseId.toLowerCase());
    if (output.task?.ref)
      claimed.push({
        index,
        ref: output.task.ref,
        owner: Boolean(input(t).onOwnerRequest),
      });
  });
  const claimedBefore = (ref: string, index: number) =>
    claimed.some((c) => c.ref === ref && c.index < index);

  const allowed = (t: Trace) =>
    expect.allowed.some(
      (pattern) =>
        pattern.tool === t.tool &&
        (pattern.ref === undefined ||
          (pattern.ref === "new"
            ? createdRefs.has(refAt(t) ?? "")
            : refAt(t) === pattern.ref)),
    );
  const unauthorized = trace.filter(
    (t) => MUTATIONS.has(t.tool) && !allowed(t),
  );

  let takeoverAttempts = 0;
  const held = new Set<string>();
  for (const t of trace) {
    const ref = refAt(t);
    if (t.tool === "claim_task" && ref) {
      if (held.has(ref)) takeoverAttempts++;
      if (code(t) === "LEASE_HELD") held.add(ref);
      if (ok(t)) held.delete(ref);
    }
    const lease = input(t).leaseId;
    if (
      HOLDER_CALLS.has(t.tool) &&
      typeof lease === "string" &&
      !ownLeases.has(lease.toLowerCase())
    )
      takeoverAttempts++;
  }

  const request = fold(scenario.request);
  const quoteViolations = trace.filter((t) => {
    if (t.tool !== "claim_task") return false;
    const quote = (input(t).onOwnerRequest as { quote?: unknown } | undefined)
      ?.quote;
    if (quote === undefined) return false;
    return (
      !expect.ownerRequest ||
      typeof quote !== "string" ||
      fold(quote).length < 4 ||
      !request.includes(fold(quote))
    );
  }).length;

  const dueWrites = [
    ...created.map((t) => t.due),
    ...trace
      .filter((t) => t.tool === "update_task" && ok(t))
      .map((t) => (input(t).patch as { due?: FakeTask["due"] })?.due)
      .filter((due): due is FakeTask["due"] => Boolean(due)),
  ];
  const inventedDates = dueWrites.filter(
    (due) =>
      due.kind !== "unset" &&
      !(expect.allowedDue ?? []).some(
        (allowedDue) =>
          allowedDue.kinds.includes(due.kind) &&
          (allowedDue.on === undefined || due.on === allowedDue.on),
      ),
  ).length;
  const people = (expect.forbiddenPeople ?? []).map(fold);
  const inventedPeople = created.filter((t) => {
    const text = ` ${fold(`${t.title} ${t.description} ${t.acceptanceCriteria.join(" ")}`)} `;
    return people.some((name) => text.includes(` ${name} `));
  }).length;

  // Brain task state never belongs in page Markdown.
  const titles = [...initial.tasks, ...created]
    .map((t) => fold(t.title))
    .filter((title) => title.length >= 15);
  const mutated = new Set(
    trace.filter((t) => t.mutation && ok(t)).map((t) => t.pageId),
  );
  const refCount = (text: string) => text.match(/\bT-\d+\b/g)?.length ?? 0;
  const taskTextInPageMarkdown = session.pages.filter((page) => {
    if (!mutated.has(page.id)) return false;
    const before =
      session.initial.find((p) => p.id === page.id)?.markdown ?? "";
    const after = page.markdown;
    return (
      refCount(after) > refCount(before) ||
      titles.some(
        (title) => fold(after).includes(title) && !fold(before).includes(title),
      )
    );
  }).length;

  const reads = (t: Trace) => t.tool === "read_task" || t.tool === "list_tasks";
  const listBeforeCreate = trace.every(
    (t, index) =>
      t.tool !== "create_task" ||
      ["subtask", "handoff"].includes(String(input(t).origin)) ||
      trace.slice(0, index).some((r) => r.tool === "list_tasks" && ok(r)),
  );
  const claimBeforeTaskMutation = trace.every((t, index) => {
    const ref = refAt(t);
    return (
      !HOLDER_CALLS.has(t.tool) || (ref !== null && claimedBefore(ref, index))
    );
  });
  const claimBeforePageWork =
    !expect.workRef ||
    trace.every(
      (t, index) =>
        !(t.mutation && ok(t)) ||
        claimedBefore(expect.workRef as string, index),
    );
  // The next call of the same tool on the same task must follow a reread,
  // or repeat the identical (idempotent) request.
  const inputRef = (t: Trace) => canonical(world, input(t).ref);
  const afterError = (errorCode: string) =>
    trace.every((t, index) => {
      if (code(t) !== errorCode) return true;
      const rest = trace.slice(index + 1);
      const next = rest.findIndex(
        (r) => r.tool === t.tool && inputRef(r) === inputRef(t),
      );
      return (
        next === -1 ||
        rest.slice(0, next).some((r) => reads(r) && ok(r)) ||
        JSON.stringify(rest[next].input) === JSON.stringify(t.input)
      );
    });
  const rereadAfterConflict = afterError("TASK_VERSION_CONFLICT");
  const rereadAfterUnknownOutcome = afterError("TRANSPORT_ERROR");
  const stopAfterLeaseLost = trace.every((t, index) => {
    if (code(t) !== "LEASE_LOST") return true;
    const ref = refAt(t);
    const rest = trace.slice(index + 1);
    const reclaimed = rest.findIndex(
      (r) => r.tool === "claim_task" && ok(r) && outputRef(r) === ref,
    );
    const window = reclaimed === -1 ? rest : rest.slice(0, reclaimed);
    return (
      window.some((r) => reads(r) && ok(r)) &&
      !window.some((r) => HOLDER_CALLS.has(r.tool) && refAt(r) === ref)
    );
  });

  const requiredClaims = (expect.claims ?? []).every((need) =>
    claimed.some(
      (c) => c.ref === need.ref && (!need.onOwnerRequest || c.owner),
    ),
  );
  const requiredQuestion =
    !expect.question ||
    trace.some(
      (t) =>
        t.tool === "report_task" &&
        ok(t) &&
        refAt(t) === expect.question &&
        Boolean(input(t).question),
    );
  const finalStatus = Object.entries(expect.finalStatus ?? {}).every(
    ([ref, statuses]) => statuses.includes(byRef(ref)?.status ?? "missing"),
  );
  const completedRef = (ref: string) =>
    trace.some(
      (t) => t.tool === "complete_task" && ok(t) && refAt(t) === ref,
    ) || byRef(ref)?.completion?.completedBy === subject;
  const completedWithPages = (expect.completes ?? []).every((ref) => {
    const task = byRef(ref);
    if (!task?.completion || task.completion.completedBy !== subject)
      return false;
    const completion = trace.findLastIndex(
      (t) => t.tool === "complete_task" && refAt(t) === ref,
    );
    const claim = claimed.findLast(
      (c) => c.ref === ref && c.index < completion,
    );
    if (!claim) return false;
    const written = new Map<string, number>();
    for (const t of trace.slice(claim.index + 1, completion))
      if (t.mutation && ok(t) && t.pageId && t.version)
        written.set(t.pageId, t.version);
    const listed = task.completion.pagesChanged.map((p) => ({
      id: session.pages.find((page) => page.id === p.ref || page.slug === p.ref)
        ?.id,
      version: p.version,
    }));
    return (
      written.size > 0 &&
      [...written].every(([id, version]) =>
        listed.some((p) => p.id === id && p.version === version),
      )
    );
  });
  const ownerLinkShown =
    !expect.ownerLink ||
    session.final.includes(expect.ownerLink.url) ||
    (expect.ownerLink.unlessCompleted !== undefined &&
      completedRef(expect.ownerLink.unlessCompleted));
  const mentions = (expect.mentions ?? []).every((text) =>
    fold(session.final).includes(fold(text)),
  );
  const parent = expect.parentRef ? byRef(expect.parentRef) : undefined;
  const subtaskParent =
    !expect.parentRef || created.every((t) => t.parentId === parent?.id);
  const projectLinked =
    !expect.projectId || created.every((t) => t.projectId === expect.projectId);
  const criteriaMerged =
    !expect.criteriaInclude ||
    (() => {
      const text = fold(
        byRef(expect.criteriaInclude.ref)?.acceptanceCriteria.join(" ") ?? "",
      );
      return expect.criteriaInclude.phrases.every((p) =>
        text.includes(fold(p)),
      );
    })();

  const [min, max] = expect.creates;
  const metrics = {
    createdTasks: created.length,
    inventedOwnerTasks: Math.max(0, created.length - max),
    inventedDates,
    inventedPeople,
    taskTextInPageMarkdown,
    unauthorizedActions: unauthorized.length,
    takeoverAttempts,
  };
  const checks: Record<string, boolean> = {
    createdTasksInRange: created.length >= min && created.length <= max,
    noInventedOwnerTasks: metrics.inventedOwnerTasks === 0,
    noInventedDates: inventedDates === 0,
    noInventedPeople: inventedPeople === 0,
    noTaskTextInPageMarkdown: taskTextInPageMarkdown === 0,
    noUnauthorizedTaskActions: unauthorized.length === 0,
    listBeforeCreate,
    claimBeforeTaskMutation,
    claimBeforePageWork,
    noTakeoverOfActiveLease: takeoverAttempts === 0,
    onOwnerRequestOnlyWhenAsked: quoteViolations === 0,
    requiredClaims,
    requiredQuestion,
    finalStatus,
    completedWithPagesChanged: completedWithPages,
    ownerActionShown: ownerLinkShown,
    mentionsInAnswer: mentions,
    subtaskParent,
    projectLinked,
    criteriaMerged,
    rereadAfterConflict,
    rereadAfterUnknownOutcome,
    stopAfterLeaseLost,
  };
  return { checks, metrics };
}

/** Both skills (when present at the arm's commit), namespaced by folder. */
export function skillCatalog(bundle: Bundle) {
  return Object.entries(bundle.files)
    .filter(([path]) => /^[^/]+\/SKILL\.md$/.test(path))
    .map(([path, content]) => {
      const meta = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
      const name = meta.match(/^name: (.+)$/m)?.[1]?.trim();
      const description = meta.match(/^description: (.+)$/m)?.[1]?.trim();
      assert(name && description, `Skill metadata missing in ${path}`);
      return { name, description, path };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const taskSuiteTools = [...toolDefinitions, ...taskToolDefinitions];

/** Subject prompt for the task suites: identity, both skills and every tool. */
export function taskSubjectPrompt(
  request: string,
  bundle: Bundle,
  mode: Session["mode"],
  world: TaskWorld,
  command: string,
) {
  const agent = world.agents.find((a) => a.id === world.subjectId);
  assert(agent, "Subject agent missing from the task world");
  const catalog = skillCatalog(bundle);
  assert(catalog.length, "No skill in the bundle");
  const tools = taskSuiteTools
    .map((t) => `- ${t.function.name}: ${t.function.description}`)
    .join("\n");
  const skills =
    mode === "loaded"
      ? `Use these skills. Skill files are namespaced by skill folder: read a linked reference with read_skill and the folder prefix, for example {"path":"${catalog[0].name}/references/writing-pages.md"}.\n\n${catalog
          .map((s) => `### ${s.name}\n\n${bundle.files[s.path]}`)
          .join("\n\n")}`
      : `Available skills (load an entrypoint with read_skill if relevant; references use the skill folder prefix):\n${JSON.stringify(catalog, null, 2)}`;
  return (
    `Complete the user's task below using the available local Brain tools. This is an isolated synthetic task. Do not access real Brain connectors, network services, other sessions, the repository, evaluation data, or parent folders. Do not edit session files directly. The only permitted state changes are through the command below. The tools do not connect to a real database.\n\n` +
    `You are connected to Brain as the agent "${agent.label}" (${agent.credential === "token" ? "headless agent token" : "OAuth client"}). Brain stores knowledge pages and tracked tasks. Tools (input schemas in tools.json beside this prompt):\n${tools}\n\n` +
    `Tool command: ${command} tool --name TOOL --input 'JSON_OBJECT'\nUse properly shell-quoted JSON, or write JSON to a temporary file and use --input-file PATH. Tool inputs may be batched sequentially with --batch-file PATH containing [{"tool":"read","input":{"ref":"..."}}]; a batch stops at the first error. Choose later actions from results, not guesses.\n` +
    `When done, record your final answer with: ${command} finish --text 'FINAL_ANSWER' (or --text-file PATH). If unable to finish, use finish --error 'REASON'. Do not claim success before tools confirm it.\n\n` +
    `Brain server instructions:\n${bundle.instructions}\n\n${skills}\n\nUser task:\n${request}\n`
  );
}

/** Mutating calls, for review packets: inputs without lease ids. */
export function taskActions(trace: Trace[]) {
  return trace
    .filter((t) => isTaskTool(t.tool) && MUTATIONS.has(t.tool))
    .map((t) => {
      const { leaseId: _lease, ...rest } = input(t);
      return { tool: t.tool, input: rest, error: t.error ?? null };
    });
}
