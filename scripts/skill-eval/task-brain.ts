import { createHash } from "node:crypto";
import { z } from "zod";
import type { PageType } from "../../lib/brain/types";
import { normalizeIdentity } from "../../lib/brain/utils";
import {
  OPEN_TASKS_LIMIT,
  type OpenTaskRow,
  type OpenTasks,
  openTasksField,
} from "../../lib/tasks/open-tasks-shape";
import {
  claimTaskSchema,
  completeTaskSchema,
  createTaskSchema,
  listTasksSchema,
  readTaskSchema,
  releaseTaskSchema,
  reportTaskSchema,
  updateTaskSchema,
} from "../../lib/tasks/schemas";
import {
  TASK_TOOL_DEFINITIONS,
  type TaskToolName,
} from "../../lib/tasks/tool-definitions";
import {
  defaultReviewPolicy,
  formatTaskRef,
  LEASE_MINUTES,
  OPEN_TASK_STATUSES,
  parseTaskRef,
  REPORT_BY_FRACTION,
  TASK_PRIORITY_LABELS,
  type TaskExpectedOutput,
  type TaskStatus,
} from "../../lib/tasks/types";

/**
 * The eight task tools, from the same definitions and Zod schemas as the MCP
 * server. Kept apart from `toolDefinitions` so the frozen toolsHash of
 * decision and activation manifests stays valid.
 */
export const taskToolDefinitions = TASK_TOOL_DEFINITIONS.map((tool) => ({
  type: "function" as const,
  function: {
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.inputSchema, {
      unrepresentable: "any",
      io: "input",
    }),
  },
}));
export const TASK_TOOL_NAMES: readonly TaskToolName[] =
  TASK_TOOL_DEFINITIONS.map((tool) => tool.name);
export const isTaskTool = (tool: string): tool is TaskToolName =>
  (TASK_TOOL_NAMES as readonly string[]).includes(tool);

export type FakeAgent = {
  id: string;
  label: string;
  kind: "owner" | "agent";
  credential: "session" | "oauth" | "token";
  capabilities: string[];
  createPolicy: "triage" | "direct";
  claimOnRequest: boolean;
  trustedCreator: boolean;
};
export type FakeDue = {
  kind: string;
  on: string | null;
  at: string | null;
  text: string | null;
  sourceExcerpt: string | null;
};
export type FakeCompletion = {
  summary: string;
  criteria: unknown[];
  artifacts: unknown[];
  remaining: string | null;
  fingerprint: string;
  pagesChanged: { ref: string; version: number }[];
  producedLinks: {
    pageId: string;
    slug: string;
    version: number;
    status: "active" | "suggested";
  }[];
  ignoredPages: { ref: string; reason: string }[];
  completedBy: string;
};
export type FakeTask = {
  id: string;
  number: number;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  status: TaskStatus;
  blockedReason: string | null;
  statusNote: string | null;
  statusNoteBy: string | null;
  priority: number;
  due: FakeDue;
  expectedOutput: TaskExpectedOutput;
  reviewPolicy: "auto" | "owner";
  requiresHuman: boolean;
  projectId: string | null;
  parentId: string | null;
  origin: string;
  ownerQuote: string | null;
  createdBy: string;
  approved: boolean;
  delegateId: string | null;
  requiredCapability: string | null;
  leads: { kind: "person" | "group"; label: string }[];
  claimedBy: string | null;
  leaseId: string | null;
  leaseExpiresAt: number | null;
  leaseMinutes: number | null;
  claimedAt: number | null;
  claimStart: "triage" | "ready" | null;
  inputRequestedAt: number | null;
  ownerAnswer: { answer: string; at: number } | null;
  contextPageIds: string[];
  producedPageIds: string[];
  completion: FakeCompletion | null;
  completedLeaseHash: string | null;
  idempotencyKey: string | null;
  idempotencyFingerprint: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
};
export type FakeTaskEvent = {
  id: number;
  taskId: string;
  action: string;
  actorId: string;
  fromStatus: string | null;
  toStatus: string | null;
  note: string | null;
  payload: Record<string, unknown>;
  at: number;
};
/** Fires once, before or after the nth matching call of the subject. */
export type WorldTrigger = {
  phase: "before" | "after";
  tool: string;
  ref?: string;
  ok?: boolean;
  occurrence?: number;
};
export type WorldAction =
  | { kind: "claim"; ref: string; agentId: string; leaseMinutes?: number }
  | {
      kind: "ownerEdit";
      ref: string;
      patch: {
        title?: string;
        description?: string;
        acceptanceCriteria?: string[];
      };
    }
  | { kind: "ownerAnswer"; ref: string; answer: string }
  | { kind: "ownerRelease"; ref: string };
export type WorldEvent = {
  trigger: WorldTrigger;
  advanceMinutes?: number;
  actions: WorldAction[];
};
/** The effect commits but the response is lost: the outcome is unknown. */
export type WorldFault = { tool: string; ref?: string; occurrence?: number };
export type PageRevision = {
  pageId: string;
  version: number;
  agentId: string;
  at: number;
};
/** Serializable task state of one trial; time is a logical clock in ms. */
export type TaskWorld = {
  now: number;
  minutesPerCall: number;
  subjectId: string;
  agents: FakeAgent[];
  tasks: FakeTask[];
  pausedProjectIds: string[];
  dependencies: { taskId: string; dependsOnId: string }[];
  revisions: PageRevision[];
  events: FakeTaskEvent[];
  serial: number;
  schedule: WorldEvent[];
  faults: WorldFault[];
};
type PageLike = {
  id: string;
  slug: string;
  title: string;
  type: PageType;
  version: number;
  markdown: string;
};
type TraceLike = { tool: string; input: unknown; error?: string };

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const iso = (ms: number | null) =>
  ms === null ? null : new Date(ms).toISOString();
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Task errors keep the server's code, remedy and details. */
export class TaskToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
  }
}
const fail = (
  code: string,
  message: string,
  remedy: string,
  details: Record<string, unknown> = {},
): never => {
  throw new TaskToolError(code, message, { ...details, remedy });
};
export const TRANSPORT_ERROR =
  "TRANSPORT_ERROR: the connection dropped before the response arrived; the outcome is unknown. Read the current state before retrying.";

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input ?? {});
  if (parsed.success) return parsed.data;
  return fail(
    "INVALID_INPUT",
    "The task request is invalid.",
    "Fix the listed fields and retry; values are checked after removing invisible and control characters.",
    {
      issues: parsed.error.issues.slice(0, 20).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    },
  );
}

/** Deterministic, valid v4-shaped UUIDs so a replay reproduces every id. */
export function fakeUuid(seed: string, kind: string, serial: number) {
  const hex = sha256(`${seed}:${kind}:${serial}`);
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function trigrams(value: string) {
  const set = new Set<string>();
  for (const word of normalizeIdentity(value).split(/[^\p{L}\p{N}]+/u))
    if (word) {
      const padded = `  ${word} `;
      for (let i = 0; i < padded.length - 2; i++)
        set.add(padded.slice(i, i + 3));
    }
  return set;
}
/** pg_trgm similarity(), used for possibleDuplicates. */
export function similarity(a: string, b: string) {
  const x = trigrams(a);
  const y = trigrams(b);
  const common = [...x].filter((t) => y.has(t)).length;
  const union = new Set([...x, ...y]).size;
  return union ? common / union : 0;
}
const stems = (value: string) =>
  normalizeIdentity(value)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 2)
    .map((term) => term.slice(0, 5));

const matches = (pattern: string | undefined, value: string | undefined) =>
  pattern === undefined ||
  (value !== undefined &&
    normalizeIdentity(pattern) === normalizeIdentity(value));
const refOf = (input: unknown) => {
  const ref = (input as { ref?: unknown } | null)?.ref;
  return typeof ref === "string" ? ref : undefined;
};

/** A deterministic, in-memory imitation of the task service for one trial. */
export class FakeTaskStore {
  readonly world: TaskWorld;
  constructor(
    world: TaskWorld,
    private readonly seed: string,
    private readonly pages: PageLike[],
  ) {
    this.world = structuredClone(world);
  }

  private agent(id: string | null) {
    const agent = this.world.agents.find((a) => a.id === id);
    if (!agent) throw new Error(`Unknown fixture agent ${id}`);
    return agent;
  }
  private get subject() {
    return this.agent(this.world.subjectId);
  }
  private find(ref: string) {
    const parsed = parseTaskRef(ref);
    const task = this.world.tasks.find((t) =>
      parsed?.kind === "number"
        ? t.number === parsed.number
        : parsed?.kind === "id" && t.id === parsed.id,
    );
    if (!task)
      return fail(
        "TASK_NOT_FOUND",
        `Task ${ref} was not found.`,
        "Use a reference such as T-42 or a task id from list_tasks.",
        { ref },
      );
    return task;
  }
  private page(ref: string) {
    return this.pages.find((p) => p.id === ref || p.slug === ref);
  }
  private project(ref: string) {
    const page = this.page(ref);
    if (!page || page.type !== "project")
      return fail(
        "PROJECT_NOT_FOUND",
        `No project page matches ${ref}.`,
        "Resolve the project with resolve or search and pass its slug or id.",
        { ref },
      );
    return page;
  }
  private serial(kind: string) {
    this.world.serial++;
    return fakeUuid(this.seed, kind, this.world.serial);
  }
  private event(
    task: FakeTask,
    action: string,
    actorId: string,
    extra: Partial<
      Pick<FakeTaskEvent, "fromStatus" | "toStatus" | "note" | "payload">
    > = {},
  ) {
    this.world.events.push({
      id: this.world.events.length + 1,
      taskId: task.id,
      action,
      actorId,
      fromStatus: extra.fromStatus ?? null,
      toStatus: extra.toStatus ?? null,
      note: extra.note ?? null,
      payload: extra.payload ?? {},
      at: this.world.now,
    });
  }
  private touch(task: FakeTask) {
    task.updatedAt = this.world.now;
  }
  private clearLease(task: FakeTask) {
    task.claimedBy = null;
    task.leaseId = null;
    task.leaseExpiresAt = null;
    task.claimedAt = null;
    task.inputRequestedAt = null;
  }

  /** Agent references flag self-declared names, as the server does. */
  private agentRef(id: string) {
    const agent = this.agent(id);
    return { label: agent.label, labelVerified: agent.kind === "owner" };
  }
  private agentName(id: string) {
    const agent = this.agent(id);
    return agent.kind === "owner"
      ? agent.label
      : `${agent.label} (unverified name)`;
  }
  /** Fixture leads are set by the owner. */
  private ownerAuthored<T>(value: T) {
    const owner = this.world.agents.find((a) => a.kind === "owner");
    return { value, untrusted: false, authoredBy: owner?.label ?? "Owner" };
  }
  private authored<T>(value: T, authorId: string) {
    const author = this.agent(authorId);
    return {
      value,
      untrusted: author.kind !== "owner",
      authoredBy: author.label,
    };
  }
  private leaseLive(task: FakeTask) {
    return task.leaseExpiresAt !== null && task.leaseExpiresAt > this.world.now;
  }
  private openBlockers(task: FakeTask) {
    return this.world.dependencies.filter(
      (d) =>
        d.taskId === task.id &&
        this.world.tasks.find((t) => t.id === d.dependsOnId)?.status !== "done",
    ).length;
  }
  private dueKey(task: FakeTask) {
    return task.due.on ?? task.due.at?.slice(0, 10) ?? "9999-12-31";
  }
  private queueOrder(a: FakeTask, b: FakeTask) {
    return (
      a.priority - b.priority ||
      this.dueKey(a).localeCompare(this.dueKey(b)) ||
      a.number - b.number
    );
  }

  private view(task: FakeTask) {
    const project = task.projectId ? this.page(task.projectId) : undefined;
    const creator = this.agent(task.createdBy);
    return {
      ref: formatTaskRef(task.number),
      id: task.id,
      number: task.number,
      title: this.authored(task.title, task.createdBy),
      description: this.authored(task.description, task.createdBy),
      acceptanceCriteria: this.authored(
        [...task.acceptanceCriteria],
        task.createdBy,
      ),
      status: task.status,
      blockedReason: task.blockedReason,
      statusNote:
        task.statusNote === null
          ? null
          : this.authored(task.statusNote, task.statusNoteBy ?? task.createdBy),
      priority: task.priority,
      priorityLabel: TASK_PRIORITY_LABELS[task.priority],
      due: {
        kind: task.due.kind,
        on: task.due.on,
        at: task.due.at,
        text:
          task.due.text === null
            ? null
            : this.authored(task.due.text, task.createdBy),
      },
      expectedOutput: task.expectedOutput,
      reviewPolicy: task.reviewPolicy,
      requiresHuman: task.requiresHuman,
      project: project
        ? {
            id: project.id,
            slug: project.slug,
            title: project.title,
            isProject: project.type === "project",
          }
        : null,
      parent: task.parentId
        ? {
            ref: formatTaskRef(
              this.world.tasks.find((t) => t.id === task.parentId)?.number ?? 0,
            ),
          }
        : null,
      origin: task.origin,
      ownerQuote:
        task.ownerQuote === null
          ? null
          : this.authored(task.ownerQuote, task.createdBy),
      createdBy: {
        label: creator.label,
        kind: creator.kind,
        labelVerified: creator.kind === "owner",
      },
      approved: task.approved,
      delegate: task.delegateId ? this.agentRef(task.delegateId) : null,
      requiredCapability: task.requiredCapability,
      claimedBy: task.claimedBy ? this.agentRef(task.claimedBy) : null,
      claimedAt: iso(task.claimedAt),
      leaseExpiresAt: iso(task.leaseExpiresAt),
      inputRequestedAt: iso(task.inputRequestedAt),
      openBlockers: this.openBlockers(task),
      completion: task.completion
        ? {
            ...this.authored(
              {
                summary: task.completion.summary,
                criteria: task.completion.criteria,
                artifacts: task.completion.artifacts,
                remaining: task.completion.remaining,
              },
              task.completion.completedBy,
            ),
            producedLinks: task.completion.producedLinks,
            ignoredPages: task.completion.ignoredPages,
          }
        : null,
      version: task.version,
      createdAt: iso(task.createdAt),
      updatedAt: iso(task.updatedAt),
    };
  }
  private row(task: FakeTask) {
    const v = this.view(task);
    return {
      ref: v.ref,
      id: v.id,
      title: v.title,
      status: v.status,
      blockedReason: v.blockedReason,
      statusNote: v.statusNote,
      priority: v.priority,
      due: v.due,
      project: v.project
        ? { slug: v.project.slug, title: v.project.title }
        : null,
      claimedBy: v.claimedBy,
      delegate: v.delegate,
      approved: v.approved,
      leaseExpiresAt: v.leaseExpiresAt,
      openBlockers: v.openBlockers,
      version: v.version,
      updatedAt: v.updatedAt,
    };
  }
  private links(task: FakeTask) {
    const link = (pageId: string, role: string, status: string) => {
      const page = this.page(pageId);
      return page
        ? {
            role,
            status,
            page: {
              id: page.id,
              slug: page.slug,
              title: page.title,
              type: page.type,
              version: page.version,
            },
          }
        : null;
    };
    return [
      ...task.contextPageIds.map((id) => link(id, "context", "active")),
      ...(task.completion?.producedLinks ?? []).map((l) =>
        link(l.pageId, "produced", l.status),
      ),
    ].filter(Boolean);
  }
  private eventsOf(task: FakeTask, limit: number) {
    return this.world.events
      .filter((e) => e.taskId === task.id)
      .slice(-limit)
      .reverse()
      .map((e) => {
        const actor = this.agent(e.actorId);
        return {
          id: e.id,
          ref: formatTaskRef(task.number),
          action: e.action,
          fromStatus: e.fromStatus,
          toStatus: e.toStatus,
          actor: { label: actor.label, kind: actor.kind },
          untrusted: actor.kind !== "owner",
          note: e.note,
          payload: e.payload,
          createdAt: iso(e.at),
        };
      });
  }
  private ownerAnswerOf(task: FakeTask) {
    return task.ownerAnswer
      ? {
          answer: task.ownerAnswer.answer,
          answeredAt: iso(task.ownerAnswer.at),
        }
      : null;
  }
  private link(ref: string, anchor: string, label: string) {
    return { kind: "owner_action", label, url: `/tasks/${ref}#${anchor}` };
  }

  private brief(task: FakeTask) {
    const ids = [
      ...new Set(
        [task.projectId, ...task.contextPageIds].filter(Boolean) as string[],
      ),
    ];
    const pages = ids.map((id) => this.page(id)).filter(Boolean) as PageLike[];
    const history = this.world.events
      .filter(
        (e) =>
          e.taskId === task.id &&
          e.note &&
          ["asked", "answered", "released", "reviewed", "reported"].includes(
            e.action,
          ),
      )
      .map(
        (e) =>
          `- ${e.action} by ${this.agent(e.actorId).label} (untrusted: ${this.agent(e.actorId).kind !== "owner"}): ${e.note}`,
      );
    const markdown = [
      ...pages.map(
        (p) =>
          `## ${p.title}\n[${p.slug}] · ${p.type} · v${p.version}\n${p.markdown}`,
      ),
      ...(history.length ? [`## Task history\n${history.join("\n")}`] : []),
    ]
      .join("\n\n")
      .slice(0, 12_000);
    return {
      markdown,
      citations: pages.map((p) => ({
        id: p.id,
        slug: p.slug,
        title: p.title,
        version: p.version,
      })),
      gaps: pages.length ? [] : ["No linked pages; use context or search."],
    };
  }

  private readNextActions(task: FakeTask) {
    const ref = formatTaskRef(task.number);
    const holder =
      task.claimedBy === this.world.subjectId && task.leaseId !== null;
    const actions: unknown[] = [];
    if (holder)
      actions.push(
        {
          kind: "tool",
          tool: "report_task",
          args: { ref },
          reason: "Report progress before reportBy to keep the lease.",
        },
        {
          kind: "tool",
          tool: "complete_task",
          args: { ref },
          reason:
            "Complete with summary, criteria, pagesChanged and artifacts.",
        },
      );
    else if (task.status === "ready" || task.status === "triage")
      actions.push({
        kind: "tool",
        tool: "claim_task",
        args: { ref },
        reason: "Claim before working; never work a task you do not hold.",
      });
    if (!task.approved && task.status === "triage")
      actions.push(
        this.link(ref, "approve", `The owner approves ${ref} in the app.`),
      );
    if (task.status === "needs_input")
      actions.push(
        this.link(
          ref,
          "answer",
          `The owner answers ${ref}'s question in the app.`,
        ),
      );
    if (task.status === "in_review")
      actions.push(
        this.link(ref, "review", `The owner reviews ${ref} in the app.`),
      );
    if (task.status === "blocked")
      actions.push(
        this.link(ref, "unblock", `The owner unblocks ${ref} in the app.`),
      );
    return actions;
  }

  private claimableState(task: FakeTask) {
    return (
      task.status === "ready" ||
      task.status === "triage" ||
      (task.status === "in_progress" &&
        task.leaseId !== null &&
        !this.leaseLive(task)) ||
      (task.status === "needs_input" &&
        task.inputRequestedAt !== null &&
        task.inputRequestedAt < this.world.now - 14 * DAY)
    );
  }
  private paused(task: FakeTask) {
    return (
      task.projectId !== null &&
      this.world.pausedProjectIds.includes(task.projectId)
    );
  }
  private standardOk(task: FakeTask, agent: FakeAgent) {
    return (
      !task.requiresHuman &&
      (task.approved || task.createdBy === agent.id) &&
      (task.delegateId === null || task.delegateId === agent.id) &&
      (task.requiredCapability === null ||
        agent.capabilities.includes(task.requiredCapability)) &&
      this.claimableState(task) &&
      !task.leads.length &&
      !this.paused(task)
    );
  }
  private queueOk(task: FakeTask, agent: FakeAgent) {
    return this.standardOk(task, agent) && !this.openBlockers(task);
  }
  private requestOk(task: FakeTask, agent: FakeAgent) {
    return (
      !task.requiresHuman &&
      (task.delegateId === null || task.delegateId === agent.id) &&
      this.claimableState(task)
    );
  }

  private takeLease(
    task: FakeTask,
    agentId: string,
    minutes: number,
    claimedFrom: string,
    quote?: string,
  ) {
    const start =
      task.status === "triage" || task.status === "ready"
        ? task.status
        : (task.claimStart ?? "ready");
    const previous = task.claimedBy;
    const from = task.status;
    task.status = "in_progress";
    task.claimedBy = agentId;
    task.leaseId = this.serial("lease");
    task.leaseExpiresAt = this.world.now + minutes * MINUTE;
    task.leaseMinutes = minutes;
    task.claimedAt = this.world.now;
    task.claimStart = start;
    task.inputRequestedAt = null;
    task.statusNote = null;
    task.statusNoteBy = null;
    this.touch(task);
    const leads = quote ? task.leads.map((l) => l.label) : [];
    this.event(task, "claimed", agentId, {
      fromStatus: from,
      toStatus: "in_progress",
      note:
        claimedFrom === "owner_request"
          ? `On the owner's request${leads.length ? `, lead: ${leads.join(", ")}` : ""}`
          : null,
      payload: {
        claimedFrom,
        startStatus: start,
        leaseMinutes: minutes,
        ...(quote ? { ownerRequest: { quote } } : {}),
        ...(leads.length ? { leads } : {}),
        ...(previous && previous !== agentId
          ? { previousHolder: this.agent(previous).label }
          : {}),
      },
    });
    return {
      leaseId: task.leaseId,
      leaseExpiresAt: iso(task.leaseExpiresAt),
      reportBy: iso(
        this.world.now + Math.round(minutes * REPORT_BY_FRACTION * MINUTE),
      ),
    };
  }

  private fence(task: FakeTask, leaseId: string) {
    const ref = formatTaskRef(task.number);
    const holder = task.claimedBy === this.world.subjectId;
    const same =
      task.leaseId !== null && task.leaseId === leaseId.toLowerCase();
    if (holder && same) return;
    const everClaimed = this.world.events.some(
      (e) =>
        e.taskId === task.id &&
        e.action === "claimed" &&
        e.actorId === this.world.subjectId,
    );
    if (!same && everClaimed)
      fail(
        "LEASE_LOST",
        `Your lease on ${ref} is no longer valid.`,
        "Read the task again with read_task: another agent may have claimed it or the owner released it. Do not repeat work blindly.",
        { ref, status: task.status },
      );
    fail(
      "NOT_TASK_HOLDER",
      `You do not hold ${ref}.`,
      "Only the agent that claimed a task reports, releases or completes it; claim a task with claim_task first.",
      { ref },
    );
  }

  /** Revisions identify who wrote each page version, for produced links. */
  recordRevision(pageId: string, version: number) {
    this.world.revisions.push({
      pageId,
      version,
      agentId: this.world.subjectId,
      at: this.world.now,
    });
  }

  /**
   * The operational field `read` and `context` add for project pages, shaped
   * as lib/tasks/open-tasks.ts: projects in the given order, at most 10 rows,
   * each row naming its project only on context results.
   */
  openTasks(
    projects: { id: string; slug: string }[],
    withProject: boolean,
  ): OpenTasks | undefined {
    const rows: OpenTaskRow[] = projects.flatMap((project) =>
      this.world.tasks
        .filter(
          (t) =>
            t.projectId === project.id &&
            (OPEN_TASK_STATUSES as readonly string[]).includes(t.status),
        )
        .sort((a, b) => this.queueOrder(a, b))
        .map((t) => ({
          ref: formatTaskRef(t.number),
          title: this.authored(t.title, t.createdBy),
          status: t.status,
          claimedBy: t.claimedBy
            ? { label: this.agent(t.claimedBy).label }
            : null,
          ...(withProject ? { project: project.slug } : {}),
        })),
    );
    if (!rows.length) return undefined;
    return openTasksField(
      rows.slice(0, OPEN_TASKS_LIMIT),
      rows.length > OPEN_TASKS_LIMIT,
    );
  }

  private count(trace: TraceLike[], match: (t: TraceLike) => boolean) {
    return trace.filter(match).length;
  }
  private matchesTrigger(
    trigger: { tool: string; ref?: string; ok?: boolean },
    entry: TraceLike,
  ) {
    return (
      entry.tool === trigger.tool &&
      matches(trigger.ref, refOf(entry.input)) &&
      (trigger.ok === undefined || trigger.ok === !entry.error)
    );
  }

  /** Scheduled world changes that precede the subject's next call. */
  before(tool: string, input: unknown, trace: TraceLike[]) {
    const next = { tool, input };
    for (const event of this.world.schedule) {
      const { trigger } = event;
      if (trigger.phase !== "before" || !this.matchesTrigger(trigger, next))
        continue;
      const seen = this.count(
        trace,
        (t) => t.tool === trigger.tool && matches(trigger.ref, refOf(t.input)),
      );
      if (seen + 1 === (trigger.occurrence ?? 1)) this.apply(event);
    }
  }

  /** Advances the clock, then fires events that follow the call just made. */
  after(trace: TraceLike[]) {
    const last = trace.at(-1);
    if (!last) return;
    this.world.now += this.world.minutesPerCall * MINUTE;
    for (const event of this.world.schedule) {
      const { trigger } = event;
      if (trigger.phase !== "after" || !this.matchesTrigger(trigger, last))
        continue;
      if (
        this.count(trace, (t) => this.matchesTrigger(trigger, t)) ===
        (trigger.occurrence ?? 1)
      )
        this.apply(event);
    }
  }

  private apply(event: WorldEvent) {
    this.world.now += (event.advanceMinutes ?? 0) * MINUTE;
    const owner = this.world.agents.find((a) => a.kind === "owner");
    if (!owner) throw new Error("Fixture world needs an owner");
    for (const action of event.actions) {
      const task = this.find(action.ref);
      if (action.kind === "claim")
        this.takeLease(
          task,
          action.agentId,
          action.leaseMinutes ?? LEASE_MINUTES.default,
          task.leaseId
            ? "expired_lease"
            : task.approved
              ? "ready"
              : "own_triage",
        );
      else if (action.kind === "ownerEdit") {
        Object.assign(task, structuredClone(action.patch));
        task.version++;
        this.touch(task);
        this.event(task, "edited", owner.id, {
          payload: { changedFields: Object.keys(action.patch) },
        });
      } else if (action.kind === "ownerAnswer") {
        task.ownerAnswer = { answer: action.answer, at: this.world.now };
        const from = task.status;
        if (task.status === "needs_input") {
          const fresh =
            task.inputRequestedAt !== null &&
            this.world.now - task.inputRequestedAt <= 7 * DAY;
          if (fresh) {
            task.status = "in_progress";
            task.leaseExpiresAt = this.world.now + 30 * MINUTE;
            task.leaseMinutes = 30;
            task.inputRequestedAt = null;
          } else {
            task.status = "ready";
            this.clearLease(task);
          }
        }
        this.touch(task);
        this.event(task, "answered", owner.id, {
          fromStatus: from,
          toStatus: task.status,
          note: action.answer,
        });
      } else {
        const from = task.status;
        task.status = task.approved ? "ready" : (task.claimStart ?? "ready");
        this.clearLease(task);
        this.touch(task);
        this.event(task, "released", owner.id, {
          fromStatus: from,
          toStatus: task.status,
          payload: { reason: "owner" },
        });
      }
    }
  }

  execute(tool: TaskToolName, input: unknown, trace: TraceLike[]): unknown {
    const output = this.run(tool, input);
    const fault = this.world.faults.find(
      (f) =>
        f.tool === tool &&
        matches(f.ref, refOf(input)) &&
        this.count(
          trace,
          (t) => t.tool === tool && matches(f.ref, refOf(t.input)),
        ) +
          1 ===
          (f.occurrence ?? 1),
    );
    if (fault) throw new Error(TRANSPORT_ERROR);
    return output;
  }

  private run(tool: TaskToolName, input: unknown): unknown {
    switch (tool) {
      case "list_tasks":
        return this.listTasks(input);
      case "read_task": {
        const data = parse(readTaskSchema, input);
        const task = this.find(data.ref);
        return {
          task: this.view(task),
          links: this.links(task),
          parties: task.leads.map((lead) => ({
            role: "lead",
            kind: lead.kind,
            label: this.ownerAuthored(lead.label),
            groupLabel:
              lead.kind === "group" ? this.ownerAuthored(lead.label) : null,
          })),
          dependencies: {
            blockedBy: this.world.dependencies
              .filter((d) => d.taskId === task.id)
              .map((d) => {
                const blocker = this.world.tasks.find(
                  (t) => t.id === d.dependsOnId,
                );
                return {
                  ref: formatTaskRef(blocker?.number ?? 0),
                  status: blocker?.status,
                };
              }),
          },
          events: this.eventsOf(task, data.eventsLimit),
          ownerAnswer: this.ownerAnswerOf(task),
          you: {
            holder:
              task.claimedBy === this.world.subjectId && task.leaseId !== null,
            creator: task.createdBy === this.world.subjectId,
          },
          ...(data.includeBrief ? { brief: this.brief(task) } : {}),
          nextActions: this.readNextActions(task),
        };
      }
      case "create_task":
        return this.createTask(input);
      case "update_task":
        return this.updateTask(input);
      case "claim_task":
        return this.claimTask(input);
      case "report_task":
        return this.reportTask(input);
      case "release_task":
        return this.releaseTask(input);
      case "complete_task":
        return this.completeTask(input);
    }
  }

  private listTasks(input: unknown) {
    const data = parse(listTasksSchema, input);
    const subject = this.subject;
    const statuses =
      data.status ?? (data.ref ? undefined : [...OPEN_TASK_STATUSES]);
    const project = data.projectRef ? this.project(data.projectRef) : null;
    const ref = data.ref ? parseTaskRef(data.ref) : null;
    const terms = data.query ? stems(data.query) : [];
    const since = data.changedSince
      ? Number(data.changedSince.split(":")[1])
      : null;
    let tasks = this.world.tasks.filter(
      (t) =>
        (!ref ||
          (ref.kind === "number"
            ? t.number === ref.number
            : t.id === ref.id)) &&
        (!statuses || (statuses as string[]).includes(t.status)) &&
        (!project || t.projectId === project.id) &&
        (!data.mine || t.claimedBy === subject.id) &&
        (!data.claimable || this.queueOk(t, subject)) &&
        (since === null ||
          this.world.events.some((e) => e.taskId === t.id && e.id > since)),
    );
    if (data.query) {
      const query = normalizeIdentity(data.query);
      const scored = tasks
        .map((task) => {
          const text = `${task.title} ${task.description} ${task.acceptanceCriteria.join(" ")}`;
          const own = new Set(stems(text));
          const hits = terms.filter((term) => own.has(term)).length;
          const substring =
            normalizeIdentity(task.title).includes(query) ||
            normalizeIdentity(task.description).includes(query);
          return { task, hits: substring ? terms.length + 1 : hits };
        })
        .filter(
          (s) =>
            s.hits > 0 && s.hits >= Math.min(2, Math.ceil(terms.length / 2)),
        )
        .sort((a, b) => b.hits - a.hits || this.queueOrder(a.task, b.task));
      tasks = scored.map((s) => s.task);
    } else tasks.sort((a, b) => this.queueOrder(a, b));
    const offset = data.cursor ? Number(data.cursor) || 0 : 0;
    const page = tasks.slice(offset, offset + data.limit);
    return {
      tasks: page.map((t) => ({
        ...this.row(t),
        ...(data.mine &&
        (t.status === "in_progress" || t.status === "needs_input")
          ? { ownerAnswer: this.ownerAnswerOf(t) }
          : {}),
      })),
      nextCursor:
        tasks.length > offset + data.limit ? String(offset + data.limit) : null,
      eventsCursor: `0:${this.world.events.length}`,
      pollAfterSeconds: 60,
    };
  }

  private createTask(input: unknown) {
    const data = parse(createTaskSchema, input);
    const subject = this.subject;
    const key = data.idempotencyKey;
    const fingerprint = sha256(
      JSON.stringify({ ...data, idempotencyKey: undefined }),
    );
    const existing = this.world.tasks.find(
      (t) => t.createdBy === subject.id && t.idempotencyKey === key,
    );
    if (existing) {
      if (existing.idempotencyFingerprint !== fingerprint)
        fail(
          "IDEMPOTENCY_KEY_CONFLICT",
          "This idempotencyKey was already used for a different task.",
          "Use a new idempotencyKey for a new task; reuse a key only to retry the identical request.",
          { idempotencyKey: key },
        );
      return this.createdResult(existing, true, []);
    }
    const triage = this.world.tasks.filter(
      (t) => t.createdBy === subject.id && t.status === "triage",
    ).length;
    let status: TaskStatus = "triage";
    let approved = false;
    if (subject.trustedCreator) {
      status = "ready";
      approved = true;
    } else if (subject.createPolicy === "direct") status = "ready";
    if (status === "triage" && triage >= 20)
      fail(
        "RATE_LIMITED",
        "This agent already has 20 tasks waiting in triage.",
        "Ask the owner to review your triage tasks in the app before creating more.",
      );
    const project = data.projectRef ? this.project(data.projectRef) : null;
    let parentId: string | null = null;
    if (data.parentRef) {
      const parent = this.find(data.parentRef);
      if (
        (data.origin === "subtask" || data.origin === "handoff") &&
        !(
          parent.claimedBy === subject.id &&
          (parent.status === "needs_input" || this.leaseLive(parent))
        )
      )
        fail(
          "NOT_TASK_HOLDER",
          `You do not hold ${data.parentRef}, so you cannot create its subtask or handoff.`,
          "Claim the parent task first, or create the task with origin owner_request if the owner asked for it.",
          { ref: data.parentRef },
        );
      parentId = parent.id;
    }
    const context = (data.contextPageRefs ?? []).map((ref) => {
      const page = this.page(ref);
      if (!page)
        return fail(
          "PAGE_NOT_FOUND",
          `No page matches ${ref}.`,
          "Resolve pages before linking them.",
          { ref },
        );
      return page.id;
    });
    const expectedOutput = data.expectedOutput ?? "none";
    const due = data.due;
    const task: FakeTask = {
      id: this.serial("task"),
      number: Math.max(0, ...this.world.tasks.map((t) => t.number)) + 1,
      title: data.title,
      description: data.description ?? "",
      acceptanceCriteria: data.acceptanceCriteria ?? [],
      status,
      blockedReason: null,
      statusNote: null,
      statusNoteBy: null,
      priority: data.priority ?? 2,
      due: {
        kind: due?.kind ?? "unset",
        on: due?.on ?? null,
        at: due?.at ?? null,
        text: due?.text ?? null,
        sourceExcerpt: due?.sourceExcerpt ?? null,
      },
      expectedOutput,
      reviewPolicy: defaultReviewPolicy(expectedOutput),
      requiresHuman: false,
      projectId: project?.id ?? null,
      parentId,
      origin: data.origin,
      ownerQuote: data.ownerQuote ?? null,
      createdBy: subject.id,
      approved,
      delegateId: null,
      requiredCapability: null,
      leads: [],
      claimedBy: null,
      leaseId: null,
      leaseExpiresAt: null,
      leaseMinutes: null,
      claimedAt: null,
      claimStart: null,
      inputRequestedAt: null,
      ownerAnswer: null,
      contextPageIds: [...new Set(context)],
      producedPageIds: [],
      completion: null,
      completedLeaseHash: null,
      idempotencyKey: key,
      idempotencyFingerprint: fingerprint,
      version: 1,
      createdAt: this.world.now,
      updatedAt: this.world.now,
    };
    this.world.tasks.push(task);
    this.event(task, "created", subject.id, {
      toStatus: status,
      payload: {
        origin: data.origin,
        approved,
        ...(due?.sourceExcerpt ? { dueSourceExcerpt: due.sourceExcerpt } : {}),
      },
    });
    const duplicates = this.world.tasks
      .filter(
        (t) =>
          t.id !== task.id &&
          !["done", "canceled"].includes(t.status) &&
          t.projectId === task.projectId &&
          similarity(t.title, task.title) >= 0.55,
      )
      .sort(
        (a, b) =>
          similarity(b.title, task.title) - similarity(a.title, task.title),
      )
      .slice(0, 5)
      .map((t) => ({
        ref: formatTaskRef(t.number),
        title: this.authored(t.title, t.createdBy),
        status: t.status,
        similarity: Math.round(similarity(t.title, task.title) * 100) / 100,
      }));
    return this.createdResult(task, false, duplicates);
  }
  private createdResult(
    task: FakeTask,
    replayed: boolean,
    duplicates: { ref: string }[],
  ) {
    const ref = formatTaskRef(task.number);
    const actions: unknown[] = [];
    if (!task.approved)
      actions.push(
        {
          kind: "tool",
          tool: "claim_task",
          args: { ref },
          reason: "You created it, so you may work it before approval.",
        },
        this.link(
          ref,
          "approve",
          `Only the owner can approve ${ref} for other agents; share this link if they want that.`,
        ),
      );
    for (const duplicate of duplicates.slice(0, 3))
      actions.push({
        kind: "tool",
        tool: "read_task",
        args: { ref: duplicate.ref },
        reason: "Possible duplicate: check it before continuing.",
      });
    return {
      task: this.view(task),
      status: task.status,
      approved: task.approved,
      replayed,
      possibleDuplicates: duplicates,
      linked: this.links(task),
      nextActions: actions,
    };
  }

  private updateTask(input: unknown) {
    const data = parse(updateTaskSchema, input);
    const subject = this.subject;
    const task = this.find(data.ref);
    const ref = formatTaskRef(task.number);
    if (task.version !== data.expectedVersion)
      fail(
        "TASK_VERSION_CONFLICT",
        `${ref} changed after it was read (version ${task.version}, expected ${data.expectedVersion}).`,
        "Read the task again with read_task, reconcile your change with the current version and retry; never overwrite blindly.",
        {
          ref,
          expectedVersion: data.expectedVersion,
          currentVersion: task.version,
        },
      );
    const patch = data.patch;
    const content = (
      [
        "title",
        "description",
        "acceptanceCriteria",
        "priority",
        "due",
        "projectRef",
      ] as const
    ).filter((key) => patch[key] !== undefined);
    const holder = task.claimedBy === subject.id && task.leaseId !== null;
    const ownUnapproved = task.createdBy === subject.id && !task.approved;
    const terminal = task.status === "done" || task.status === "canceled";
    if (content.length && (!ownUnapproved || terminal))
      fail(
        "NOT_ALLOWED",
        holder
          ? `As the holder of ${ref} you cannot redefine its content.`
          : `Only the owner can edit ${ref} now.`,
        "Put findings in report_task notes or contextPageRefs, or ask the owner to edit the task in the app.",
        { ref, fields: content },
      );
    if (
      patch.status === "canceled" &&
      !(
        ownUnapproved &&
        task.claimedBy === null &&
        (task.status === "triage" || task.status === "ready")
      )
    )
      fail(
        "NOT_ALLOWED",
        `You cannot cancel ${ref}.`,
        "Agents cancel only their own tasks that are neither approved nor claimed; release a claim first, or ask the owner.",
        { ref },
      );
    if (patch.contextPageRefs && !ownUnapproved && !holder)
      fail(
        "NOT_ALLOWED",
        `Only the creator, the holder or the owner change ${ref}'s context pages.`,
        "Claim the task first, or mention the pages in your report.",
        { ref },
      );
    const changed: string[] = [];
    if (patch.title !== undefined && patch.title !== task.title) {
      task.title = patch.title;
      changed.push("title");
    }
    if (patch.description !== undefined) {
      task.description = patch.description;
      changed.push("description");
    }
    if (patch.acceptanceCriteria !== undefined) {
      task.acceptanceCriteria = patch.acceptanceCriteria;
      changed.push("acceptanceCriteria");
    }
    if (patch.priority !== undefined) {
      task.priority = patch.priority;
      changed.push("priority");
    }
    if (patch.due !== undefined) {
      task.due = {
        kind: patch.due.kind,
        on: patch.due.on ?? null,
        at: patch.due.at ?? null,
        text: patch.due.text ?? null,
        sourceExcerpt: patch.due.sourceExcerpt ?? null,
      };
      changed.push("due");
    }
    if (patch.projectRef === null) {
      task.projectId = null;
      changed.push("project");
    } else if (patch.projectRef !== undefined) {
      task.projectId = this.project(patch.projectRef).id;
      changed.push("project");
    }
    if (patch.contextPageRefs) {
      const resolve = (ref: string) => {
        const page = this.page(ref);
        if (!page)
          return fail(
            "PAGE_NOT_FOUND",
            `No page matches ${ref}.`,
            "Resolve pages before linking them.",
            { ref },
          );
        return page.id;
      };
      const add = (patch.contextPageRefs.add ?? []).map(resolve);
      const remove = new Set((patch.contextPageRefs.remove ?? []).map(resolve));
      task.contextPageIds = [
        ...new Set([...task.contextPageIds, ...add]),
      ].filter((id) => !remove.has(id));
      changed.push("contextPageRefs");
    }
    const canceling = patch.status === "canceled";
    if (canceling) {
      this.event(task, "status_changed", subject.id, {
        fromStatus: task.status,
        toStatus: "canceled",
      });
      task.status = "canceled";
      this.clearLease(task);
    }
    if (changed.length || canceling) {
      task.version++;
      this.touch(task);
    }
    if (changed.length)
      this.event(task, "edited", subject.id, {
        payload: { changedFields: changed },
      });
    return { task: this.view(task), changedFields: changed };
  }

  private claimTask(input: unknown) {
    const data = parse(claimTaskSchema, input);
    const subject = this.subject;
    if (data.onOwnerRequest && !subject.claimOnRequest)
      fail(
        "CLAIM_ON_REQUEST_DISABLED",
        "This agent cannot claim tasks on the owner's request.",
        "Ask the owner to approve the task in the app, or to enable 'Can claim on request' for this agent in /agents.",
      );
    const minutes = data.leaseMinutes ?? LEASE_MINUTES.default;
    let task: FakeTask;
    let claimedFrom: string;
    if (data.ref) {
      task = this.find(data.ref);
      const ref = formatTaskRef(task.number);
      const quote = data.onOwnerRequest?.quote;
      const ok = quote
        ? this.requestOk(task, subject)
        : this.standardOk(task, subject);
      if (!ok) {
        const notClaimable = (
          reason: string,
          message: string,
          remedy: string,
          details: Record<string, unknown> = {},
        ) =>
          fail("NOT_CLAIMABLE", message, remedy, {
            ref,
            status: task.status,
            reason,
            ...details,
          });
        if (task.requiresHuman)
          notClaimable(
            "requires_human",
            `${ref} needs a step only a person can take.`,
            "Do not claim it; tell the owner it requires a human step.",
          );
        if (task.delegateId && task.delegateId !== subject.id) {
          const delegate = this.agentRef(task.delegateId);
          notClaimable(
            "assigned_to_other_agent",
            `${ref} is assigned to ${this.agentName(task.delegateId)}.`,
            "Only the assigned agent can claim it, even on request: name it to the owner, who can change the assignment in the app.",
            {
              agent: delegate.label,
              agentLabelVerified: delegate.labelVerified,
            },
          );
        }
        if (
          (task.status === "in_progress" || task.status === "needs_input") &&
          task.claimedBy !== null
        )
          fail(
            "LEASE_HELD",
            `${ref} is held by ${this.agentName(task.claimedBy)}.`,
            "Choose another task; do not take over an active lease.",
            {
              ref,
              status: task.status,
              holder: this.agent(task.claimedBy).label,
              holderLabelVerified: this.agentRef(task.claimedBy).labelVerified,
              leaseExpiresAt: iso(task.leaseExpiresAt),
            },
          );
        if (!["ready", "triage"].includes(task.status))
          notClaimable(
            "status",
            `${ref} is ${task.status} and cannot be claimed.`,
            task.status === "on_hold"
              ? "The owner put it on hold; only they resume it."
              : "Only ready or triage tasks can be claimed.",
          );
        if (!task.approved && task.createdBy !== subject.id)
          notClaimable(
            "not_approved",
            `${ref} is not approved for other agents.`,
            "Ask the owner to approve it in the app; claim it with onOwnerRequest only if the owner explicitly asked you to take it in this conversation.",
          );
        if (
          task.requiredCapability &&
          !subject.capabilities.includes(task.requiredCapability)
        )
          notClaimable(
            "missing_capability",
            `${ref} requires a capability you do not have.`,
            "Leave it to an agent with that capability.",
          );
        if (task.leads.length)
          notClaimable(
            "human_lead",
            `${ref} is led by a person or group.`,
            "Do not take it from the queue; the owner may ask you explicitly to take it.",
            { leads: task.leads.map((l) => this.ownerAuthored(l.label)) },
          );
        if (this.paused(task))
          notClaimable(
            "project_paused",
            `${ref}'s project is paused.`,
            "Do not take it from the queue; the owner may ask you explicitly to take it.",
          );
        notClaimable(
          "not_claimable",
          `${ref} cannot be claimed now.`,
          "Read it with read_task and choose another task.",
        );
      }
      claimedFrom = quote
        ? "owner_request"
        : task.leaseId !== null && !this.leaseLive(task)
          ? "expired_lease"
          : task.status === "needs_input"
            ? "stale_question"
            : task.approved
              ? "ready"
              : "own_triage";
    } else {
      const next = data.next ?? {};
      const project = next.projectRef ? this.project(next.projectRef) : null;
      const terms = next.query ? stems(next.query) : [];
      const candidate = this.world.tasks
        .filter(
          (t) =>
            this.queueOk(t, subject) &&
            (!project || t.projectId === project.id) &&
            (!terms.length ||
              terms.some((term) => stems(t.title).includes(term))),
        )
        .sort((a, b) => this.queueOrder(a, b))[0];
      if (!candidate)
        return fail(
          "NO_CLAIMABLE_TASK",
          "No task is claimable for you right now.",
          "Retry after 300 seconds, or ask the owner what to work on.",
          { retryAfterSeconds: 300 },
        );
      task = candidate;
      claimedFrom =
        task.leaseId !== null
          ? "expired_lease"
          : task.approved
            ? "ready"
            : "own_triage";
    }
    const lease = this.takeLease(
      task,
      subject.id,
      minutes,
      claimedFrom,
      data.onOwnerRequest?.quote,
    );
    const ref = formatTaskRef(task.number);
    return {
      task: this.view(task),
      ...lease,
      claimedFrom,
      brief: this.brief(task),
      links: this.links(task),
      requiredReport: [
        "summary",
        "criteria",
        "pagesChanged",
        "artifacts",
        "remaining",
      ],
      nextActions: [
        {
          kind: "tool",
          tool: "report_task",
          args: { ref },
          reason: `Report before ${lease.reportBy} with your leaseId; that is the only way to renew the lease.`,
        },
        {
          kind: "tool",
          tool: "complete_task",
          args: { ref },
          reason:
            "Write durable knowledge to pages first, then complete with pagesChanged.",
        },
      ],
    };
  }

  private reportTask(input: unknown) {
    const data = parse(reportTaskSchema, input);
    const task = this.find(data.ref);
    const ref = formatTaskRef(task.number);
    this.fence(task, data.leaseId);
    const minutes =
      data.leaseMinutes ?? task.leaseMinutes ?? LEASE_MINUTES.default;
    const from = task.status;
    if (data.question) {
      task.status = "needs_input";
      task.statusNote = data.question.prompt;
      task.statusNoteBy = this.world.subjectId;
      task.leaseExpiresAt = null;
      task.inputRequestedAt = this.world.now;
    } else if (task.status === "in_progress") {
      task.leaseExpiresAt = this.world.now + minutes * MINUTE;
      task.leaseMinutes = minutes;
    }
    this.touch(task);
    this.event(task, "reported", this.world.subjectId, {
      note: data.note,
      payload: task.status === "in_progress" ? { leaseMinutes: minutes } : {},
    });
    if (data.question)
      this.event(task, "asked", this.world.subjectId, {
        fromStatus: from,
        toStatus: "needs_input",
        note: data.question.prompt,
        payload: data.question.choices?.length
          ? { choices: data.question.choices }
          : {},
      });
    const waiting = task.status === "needs_input";
    return {
      ref,
      status: task.status,
      leaseExpiresAt: iso(task.leaseExpiresAt),
      reportBy: waiting
        ? null
        : iso(
            this.world.now + Math.round(minutes * REPORT_BY_FRACTION * MINUTE),
          ),
      ownerAnswer: data.question ? null : this.ownerAnswerOf(task),
      ...(waiting ? { pollAfterSeconds: 60 } : {}),
      nextActions: waiting
        ? [
            this.link(
              ref,
              "answer",
              `Show the owner this link to answer your question on ${ref}.`,
            ),
            {
              kind: "tool",
              tool: "read_task",
              args: { ref },
              reason:
                "Poll every 60 seconds or later for the answer; you keep the claim meanwhile.",
            },
          ]
        : [
            {
              kind: "tool",
              tool: "complete_task",
              args: { ref },
              reason:
                "Write durable knowledge to pages first, then complete with pagesChanged.",
            },
          ],
    };
  }

  private releaseTask(input: unknown) {
    const data = parse(releaseTaskSchema, input);
    const task = this.find(data.ref);
    const ref = formatTaskRef(task.number);
    this.fence(task, data.leaseId);
    const from = task.status;
    task.status =
      data.reason === "blocked"
        ? "blocked"
        : task.approved
          ? "ready"
          : task.claimStart === "triage"
            ? "triage"
            : "ready";
    task.blockedReason = data.blockedReason ?? null;
    task.statusNote = data.note.slice(0, 2_000);
    task.statusNoteBy = this.world.subjectId;
    this.clearLease(task);
    this.touch(task);
    this.event(task, "released", this.world.subjectId, {
      fromStatus: from,
      toStatus: task.status,
      note: data.note,
      payload: {
        reason: data.reason,
        ...(data.blockedReason ? { blockedReason: data.blockedReason } : {}),
      },
    });
    return {
      ref,
      status: task.status,
      nextActions:
        task.status === "blocked"
          ? [
              this.link(
                ref,
                "unblock",
                `Show the owner this link: ${ref} is blocked (${data.blockedReason}).`,
              ),
            ]
          : [],
    };
  }

  private completeTask(input: unknown) {
    const data = parse(completeTaskSchema, input);
    const task = this.find(data.ref);
    const ref = formatTaskRef(task.number);
    const leaseHash = sha256(data.leaseId.toLowerCase());
    const fingerprint = sha256(
      JSON.stringify({
        summary: data.summary,
        criteria: data.criteria,
        pagesChanged: data.pagesChanged,
        artifacts: data.artifacts,
        remaining: data.remaining ?? null,
      }),
    );
    if (task.leaseId === null && task.completedLeaseHash === leaseHash) {
      if (task.completion?.fingerprint !== fingerprint)
        fail(
          "ALREADY_COMPLETED",
          `${ref} was already completed with a different report under this lease.`,
          "Read the task with read_task; do not complete it again.",
          { ref, status: task.status },
        );
      return {
        ref,
        status: task.status,
        producedLinks: task.completion?.producedLinks ?? [],
        ignoredPages: task.completion?.ignoredPages ?? [],
        replayed: true,
        nextActions: [],
      };
    }
    this.fence(task, data.leaseId);
    const count = task.acceptanceCriteria.length;
    const out = data.criteria.filter((c) => c.index >= count);
    if (out.length)
      fail(
        "INVALID_INPUT",
        `${ref} has ${count} acceptance criteria.`,
        "Report criteria by their zero-based index in the task's acceptanceCriteria.",
        { indexes: out.map((c) => c.index) },
      );
    const missing: string[] = [];
    for (let index = 0; index < count; index++)
      if (!data.criteria.some((c) => c.index === index))
        missing.push(`criteria[${index}]`);
    if (data.criteria.some((c) => c.status !== "met") && !data.remaining)
      missing.push("remaining");
    if (missing.length)
      fail(
        "REPORT_INCOMPLETE",
        `The completion report for ${ref} is incomplete.`,
        "Report every acceptance criterion with evidence, and describe what remains when a criterion is not fully met.",
        { ref, missing },
      );
    const produced: FakeCompletion["producedLinks"] = [];
    const ignored: FakeCompletion["ignoredPages"] = [];
    const seen = new Set<string>();
    for (const entry of data.pagesChanged) {
      const key = `${entry.ref}@${entry.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const page = this.page(entry.ref);
      if (!page) {
        ignored.push({ ref: entry.ref, reason: "page_not_found" });
        continue;
      }
      const revision = this.world.revisions.find(
        (r) => r.pageId === page.id && r.version === entry.version,
      );
      if (!revision) {
        ignored.push({ ref: entry.ref, reason: "no_revision" });
        continue;
      }
      const verified =
        revision.agentId === this.world.subjectId &&
        task.claimedAt !== null &&
        revision.at >= task.claimedAt;
      produced.push({
        pageId: page.id,
        slug: page.slug,
        version: entry.version,
        status: verified ? "active" : "suggested",
      });
      if (verified && !task.producedPageIds.includes(page.id))
        task.producedPageIds.push(page.id);
    }
    if (
      (task.expectedOutput === "page" || task.expectedOutput === "decision") &&
      !task.producedPageIds.length
    )
      fail(
        "OUTPUT_REQUIRED",
        `${ref} expects a ${task.expectedOutput} page that you wrote while holding it.`,
        "Write the outcome with write or append, then list the page and the version they returned in pagesChanged.",
        { ref, expectedOutput: task.expectedOutput, ignoredPages: ignored },
      );
    if (task.expectedOutput === "artifact" && !data.artifacts.length)
      fail(
        "OUTPUT_REQUIRED",
        `${ref} expects an artifact.`,
        "List the pull request, branch, commit, URL or file in artifacts.",
        { ref, expectedOutput: task.expectedOutput },
      );
    const from = task.status;
    task.status = task.reviewPolicy === "owner" ? "in_review" : "done";
    task.completion = {
      summary: data.summary,
      criteria: data.criteria,
      artifacts: data.artifacts,
      remaining: data.remaining ?? null,
      fingerprint,
      pagesChanged: data.pagesChanged,
      producedLinks: produced,
      ignoredPages: ignored,
      completedBy: this.world.subjectId,
    };
    task.completedLeaseHash = leaseHash;
    task.blockedReason = null;
    task.statusNote = null;
    this.clearLease(task);
    this.touch(task);
    this.event(task, "completed", this.world.subjectId, {
      fromStatus: from,
      toStatus: task.status,
      note: data.summary,
      payload: {
        producedLinks: produced.length,
        ignoredPages: ignored.length,
        artifacts: data.artifacts.length,
      },
    });
    return {
      ref,
      status: task.status,
      producedLinks: produced,
      ignoredPages: ignored,
      replayed: false,
      nextActions:
        task.status === "in_review"
          ? [
              this.link(
                ref,
                "review",
                `Show the owner this link to review ${ref}.`,
              ),
            ]
          : [],
    };
  }
}
