import { ArrowUpRight, CircleAlert, X } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import {
  decideLinkAction,
  dependencyAction,
  removePartyAction,
  taskOperationAction,
} from "@/app/(workspace)/actions/tasks";
import { Badge } from "@/components/ui/badge";
import { BrainError } from "@/lib/brain/types";
import { formatDate } from "@/lib/formatters";
import {
  TASK_LINK_ROLES,
  type TaskLinkOrigin,
  type TaskLinkRole,
} from "@/lib/tasks/types";
import { getWorkspacePages } from "@/lib/workspace/data";
import { canonicalTaskRef, taskHref } from "@/lib/workspace/task-urls";
import {
  getTaskActivity,
  getTaskDetail,
  getTaskFormChoices,
  getTaskKnowledge,
  getTaskParties,
  getTaskSuggestions,
} from "@/lib/workspace/tasks-data";
import { CONNECTION_PAGE_SIZE, pageHref } from "@/lib/workspace/urls";
import { ActionButton } from "./action-state";
import {
  BLOCKED_REASON_LABELS,
  dueLabel,
  EXPECTED_OUTPUT_LABELS,
  LINK_ORIGIN_LABELS,
  LINK_ROLE_LABELS,
  ORIGIN_LABELS,
} from "./labels";
import { LeaseCountdown } from "./lease-countdown";
import { PurgeForm } from "./purge-form";
import { QuestionForm } from "./question-form";
import { ReviewPanel } from "./review-panel";
import { AuthoredBy, PriorityLabel, StatusBadge } from "./status";
import { SuggestionCard } from "./suggestion-card";
import { TaskActions } from "./task-actions";
import { TaskActivity } from "./task-activity";
import {
  DelegateSelect,
  DependencyForm,
  LinkForm,
  PartyForm,
} from "./task-editors";
import { TaskMarkdown } from "./task-markdown";

export type TaskParams = Promise<{ ref: string }>;

export async function readTaskDetail(params: TaskParams) {
  const { ref } = await params;
  const canonical = canonicalTaskRef(ref);
  if (!canonical) notFound();
  try {
    return await getTaskDetail(canonical);
  } catch (error) {
    if (error instanceof BrainError && error.code === "TASK_NOT_FOUND")
      notFound();
    throw error;
  }
}

export async function TaskRefLabel({ params }: { params: TaskParams }) {
  const { task } = await readTaskDetail(params);
  return (
    <span className="font-mono tracking-wide">
      {task.ref} · VERSION {task.version}
    </span>
  );
}

export async function TaskHeader({ params }: { params: TaskParams }) {
  const { task } = await readTaskDetail(params);
  const due = dueLabel(task.due);
  return (
    <header className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={task.status} />
        {task.status === "blocked" && task.blockedReason && (
          <Badge variant="outline">
            {
              BLOCKED_REASON_LABELS[
                task.blockedReason as keyof typeof BLOCKED_REASON_LABELS
              ]
            }
          </Badge>
        )}
        {!task.approved && <Badge variant="outline">Not approved</Badge>}
        {task.archivedAt && <Badge variant="outline">Archived</Badge>}
        <PriorityLabel priority={task.priority} />
        {task.claimedBy && task.leaseExpiresAt && (
          <LeaseCountdown
            expiresAt={task.leaseExpiresAt}
            holder={task.claimedBy.label}
          />
        )}
        {task.claimedBy && !task.leaseExpiresAt && (
          <Badge variant="outline">Held by {task.claimedBy.label}</Badge>
        )}
      </div>
      <div className="space-y-2">
        <h1 className="max-w-[860px] font-serif text-4xl leading-[1.15] font-normal tracking-[-0.04em] wrap-anywhere sm:text-5xl">
          {task.title.value}
        </h1>
        <AuthoredBy authored={task.title} />
      </div>
      {(due || task.statusNote) && (
        <dl className="grid max-w-[760px] gap-x-6 gap-y-2 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
          {due && (
            <>
              <dt className="text-muted-foreground">Due</dt>
              <dd className="wrap-anywhere">{due}</dd>
            </>
          )}
          {task.statusNote && task.status !== "needs_input" && (
            <>
              <dt className="text-muted-foreground">Note</dt>
              <dd className="whitespace-pre-wrap wrap-anywhere">
                {task.statusNote.value}{" "}
                <AuthoredBy authored={task.statusNote} />
              </dd>
            </>
          )}
        </dl>
      )}
      <TaskActions
        task={{
          ref: task.ref,
          status: task.status,
          approved: task.approved,
          version: task.version,
          claimCount: task.claimCount,
          claimed: Boolean(task.claimedBy),
          archived: Boolean(task.archivedAt),
        }}
      />
    </header>
  );
}

function Panel({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="scroll-mt-20 space-y-4 rounded-xl border border-ring/40 bg-card p-5"
    >
      <h2 id={`${id}-title`} className="flex items-center gap-2 font-medium">
        <CircleAlert size={16} aria-hidden="true" className="text-brand" />
        {title}
      </h2>
      {children}
    </section>
  );
}

/** The step only the owner can take, at the anchor agents link to. */
export async function TaskOwnerPanels({ params }: { params: TaskParams }) {
  const { task, question, onRequest } = await readTaskDetail(params);
  const panels: ReactNode[] = [];
  if (!task.approved && ["triage", "ready"].includes(task.status))
    panels.push(
      <Panel key="approve" id="approve" title="Approve this task?">
        <p className="text-sm text-muted-foreground">
          {task.createdBy.label} created it. Until you approve it, only its
          creator works on it
          {task.status === "triage"
            ? ""
            : " (it is ready for its creator only)"}
          .
        </p>
        <div className="flex flex-wrap gap-2">
          <ActionButton
            errorClassName="basis-full"
            action={taskOperationAction.bind(null, task.ref, "approve", {
              expectedVersion: task.version,
            })}
          >
            Approve
          </ActionButton>
          <ActionButton
            variant="ghost"
            errorClassName="basis-full"
            action={taskOperationAction.bind(null, task.ref, "reject", {
              expectedVersion: task.version,
            })}
          >
            Reject
          </ActionButton>
        </div>
      </Panel>,
    );
  if (question)
    panels.push(
      <Panel key="answer" id="answer" title="Answer the question">
        <QuestionForm
          taskRef={task.ref}
          version={task.version}
          inputRequestedAt={task.inputRequestedAt}
          prompt={question.prompt?.value ?? "The holder is waiting for you."}
          askedBy={question.askedBy}
          choices={question.choices}
          stale={question.stale}
        />
      </Panel>,
    );
  if (task.status === "in_review")
    panels.push(
      <Panel key="review" id="review" title="Review the work">
        <ReviewPanel task={task} />
      </Panel>,
    );
  if (task.status === "blocked")
    panels.push(
      <Panel key="unblock" id="unblock" title="Blocked">
        <p className="text-sm text-muted-foreground">
          {task.blockedReason
            ? BLOCKED_REASON_LABELS[
                task.blockedReason as keyof typeof BLOCKED_REASON_LABELS
              ]
            : "Blocked"}
          {task.openBlockers > 0 &&
            ` · ${task.openBlockers} open ${task.openBlockers === 1 ? "dependency" : "dependencies"}`}
        </p>
        <ActionButton
          errorClassName="basis-full"
          action={taskOperationAction.bind(null, task.ref, "unblock", {
            expectedVersion: task.version,
          })}
        >
          Unblock
        </ActionButton>
      </Panel>,
    );
  if (onRequest)
    panels.push(
      <Panel key="revoke" id="revoke" title="Claimed on your request">
        <p className="text-sm wrap-anywhere">
          {task.claimedBy?.label ?? "An agent"} quotes you: “
          {onRequest.quote.value}”
          {onRequest.leads.length > 0 &&
            ` · ${onRequest.leads.join(", ")} stays lead`}
        </p>
        <ActionButton
          variant="outline"
          errorClassName="basis-full"
          action={taskOperationAction.bind(null, task.ref, "release", {
            expectedVersion: task.version,
            claimCount: task.claimCount,
          })}
        >
          Revoke
        </ActionButton>
      </Panel>,
    );
  if (!panels.length) return null;
  return <div className="space-y-4">{panels}</div>;
}

export async function TaskDescription({ params }: { params: TaskParams }) {
  const { task } = await readTaskDetail(params);
  const criteria = task.acceptanceCriteria.value;
  return (
    <div className="space-y-8">
      <section aria-labelledby="description-title" className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 id="description-title" className="font-medium">
            Description
          </h2>
          <AuthoredBy authored={task.description} />
        </div>
        {task.description.value.trim() ? (
          <div className="markdown-body max-w-[740px]">
            <TaskMarkdown markdown={task.description.value} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No description.</p>
        )}
      </section>
      <section aria-labelledby="criteria-title" className="space-y-3">
        <h2 id="criteria-title" className="font-medium">
          Acceptance criteria
        </h2>
        {criteria.length ? (
          <ol className="max-w-[740px] list-decimal space-y-1.5 pl-6 text-sm">
            {criteria.map((criterion, index) => (
              // Criteria are positional: completion reports cite them by index.
              // biome-ignore lint/suspicious/noArrayIndexKey: positional list
              <li key={index} className="wrap-anywhere">
                {criterion}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">
            No criteria. Agents report against these when they complete.
          </p>
        )}
      </section>
    </div>
  );
}

const ORIGIN_BADGE: Record<TaskLinkOrigin, string> = LINK_ORIGIN_LABELS;

export async function TaskKnowledge({ params }: { params: TaskParams }) {
  const { task } = await readTaskDetail(params);
  const [links, pages] = await Promise.all([
    getTaskKnowledge(task.id),
    getWorkspacePages({ sort: "title", limit: CONNECTION_PAGE_SIZE }),
  ]);
  const byRole = TASK_LINK_ROLES.map((role) => ({
    role,
    links: links.filter((link) => link.role === role),
  })).filter((group) => group.links.length);
  return (
    <section aria-labelledby="knowledge-title" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="knowledge-title" className="font-medium">
          Linked knowledge
        </h2>
        <LinkForm
          taskRef={task.ref}
          pages={{
            pages: pages.pages.map(({ id, title }) => ({ id, title })),
            total: pages.total,
          }}
        />
      </div>
      {byRole.length ? (
        byRole.map((group) => (
          <div key={group.role} className="space-y-2">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {LINK_ROLE_LABELS[group.role as TaskLinkRole]}
            </h3>
            <ul className="space-y-2">
              {group.links.map((link) => {
                const suggested = link.status === "suggested";
                return (
                  <li
                    key={`${link.page.id}:${link.role}`}
                    className={`space-y-2 rounded-lg border p-3 ${suggested ? "border-dashed" : ""}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={pageHref(link.page.id)}
                        className="min-w-0 font-medium wrap-anywhere hover:underline"
                      >
                        {link.page.title}
                      </Link>
                      <Badge variant="outline">
                        {ORIGIN_BADGE[link.origin as TaskLinkOrigin] ??
                          link.origin}
                      </Badge>
                      {suggested && (
                        <span className="text-xs text-muted-foreground">
                          {link.origin === "consolidator"
                            ? "Suggested by nightly maintenance"
                            : "Suggested"}
                          {link.confidence !== null &&
                            ` · ${link.confidence.toFixed(2)}`}
                        </span>
                      )}
                    </div>
                    {link.passage && (
                      <blockquote className="border-l-2 pl-3 text-sm whitespace-pre-wrap text-muted-foreground wrap-anywhere">
                        {link.passage}
                      </blockquote>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      {suggested ? (
                        <>
                          <ActionButton
                            size="sm"
                            variant="outline"
                            errorClassName="basis-full"
                            action={decideLinkAction.bind(
                              null,
                              task.ref,
                              link.page.id,
                              link.role,
                              "active",
                            )}
                          >
                            Accept
                          </ActionButton>
                          <ActionButton
                            size="sm"
                            variant="ghost"
                            errorClassName="basis-full"
                            action={decideLinkAction.bind(
                              null,
                              task.ref,
                              link.page.id,
                              link.role,
                              "rejected",
                            )}
                          >
                            Reject
                          </ActionButton>
                        </>
                      ) : (
                        link.role !== "produced" && (
                          <ActionButton
                            size="xs"
                            variant="ghost"
                            errorClassName="basis-full"
                            action={decideLinkAction.bind(
                              null,
                              task.ref,
                              link.page.id,
                              link.role,
                              "rejected",
                            )}
                          >
                            <X aria-hidden="true" /> Remove
                          </ActionButton>
                        )
                      )}
                      <Link
                        href={pageHref(link.page.id)}
                        className="ml-auto text-xs text-muted-foreground hover:text-foreground"
                      >
                        v{link.page.version}{" "}
                        <ArrowUpRight size={12} className="inline" />
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      ) : (
        <p className="text-sm text-muted-foreground">
          No linked pages yet. Context links appear when you or an agent name
          pages; nightly maintenance suggests more.
        </p>
      )}
    </section>
  );
}

export async function TaskSuggestions({ params }: { params: TaskParams }) {
  const { task } = await readTaskDetail(params);
  const suggestions = await getTaskSuggestions(task.id);
  if (!suggestions.length) return null;
  return (
    <section aria-labelledby="suggestions-title" className="space-y-3">
      <h2 id="suggestions-title" className="font-medium">
        Suggestions
      </h2>
      <div className="space-y-3">
        {suggestions.map((suggestion) => (
          <SuggestionCard
            key={suggestion.id}
            suggestion={suggestion}
            showTask={false}
          />
        ))}
      </div>
    </section>
  );
}

export async function TaskHistory({ params }: { params: TaskParams }) {
  const { task } = await readTaskDetail(params);
  const events = await getTaskActivity(task.id);
  return (
    <section
      id="activity"
      aria-labelledby="activity-title"
      className="scroll-mt-20 space-y-4"
    >
      <h2 id="activity-title" className="font-medium">
        Activity
      </h2>
      <TaskActivity events={events} />
    </section>
  );
}

function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm wrap-anywhere">{children}</dd>
    </div>
  );
}

export async function TaskProperties({ params }: { params: TaskParams }) {
  const detail = await readTaskDetail(params);
  const { task } = detail;
  const [parties, choices, people] = await Promise.all([
    getTaskParties(task.id),
    getTaskFormChoices(),
    getWorkspacePages({
      type: "person",
      sort: "title",
      limit: CONNECTION_PAGE_SIZE,
    }),
  ]);
  const origin = ORIGIN_LABELS[task.origin as keyof typeof ORIGIN_LABELS];
  return (
    <aside
      aria-label="Task properties"
      className="space-y-6 border-t pt-6 xl:border-t-0 xl:border-l xl:pt-0 xl:pl-6"
    >
      <dl className="space-y-4">
        <Property label="Project">
          {task.project ? (
            <span className="flex flex-wrap items-center gap-2">
              <Link
                href={pageHref(task.project.id)}
                className="hover:underline"
              >
                {task.project.title}
              </Link>
              {!task.project.isProject && (
                <Badge variant="outline">No longer a project</Badge>
              )}
            </span>
          ) : (
            <span className="text-muted-foreground">None</span>
          )}
        </Property>
        <Property label="Provenance">
          Created by{" "}
          {task.createdBy.kind === "owner" ? "you" : task.createdBy.label}
          {origin ? ` · ${origin}` : ""}
          {task.ownerQuote && (
            <span className="mt-1 block text-muted-foreground">
              “{task.ownerQuote.value}”
            </span>
          )}
          {detail.source && (
            <span className="mt-1 block">
              Source:{" "}
              <Link
                href={pageHref(detail.source.page.id)}
                className="hover:underline"
              >
                {detail.source.page.title}
              </Link>
              {detail.source.version ? ` · v${detail.source.version}` : ""}
            </span>
          )}
          {task.approvedBy && (
            <span className="mt-1 block text-muted-foreground">
              Approved by{" "}
              {task.approvedBy.label === task.createdBy.label &&
              task.createdBy.kind === "owner"
                ? "you"
                : task.approvedBy.label}
              {task.approvedAt ? ` · ${formatDate(task.approvedAt)}` : ""}
            </span>
          )}
        </Property>
        <Property label="Delegate to">
          <span id="delegate" className="block scroll-mt-20">
            <DelegateSelect
              taskRef={task.ref}
              version={task.version}
              delegateId={task.delegateId}
              delegateLabel={task.delegate?.label ?? null}
              agents={choices.agents}
            />
          </span>
        </Property>
        <Property label="Who closes it">
          {task.reviewPolicy === "owner"
            ? "You, after review"
            : "The agent that completes it"}
        </Property>
        <Property label="Expected output">
          {EXPECTED_OUTPUT_LABELS[
            task.expectedOutput as keyof typeof EXPECTED_OUTPUT_LABELS
          ] ?? task.expectedOutput}
        </Property>
        {task.requiredCapability && (
          <Property label="Required capability">
            <Badge variant="secondary">{task.requiredCapability}</Badge>
          </Property>
        )}
        {task.requiresHuman && (
          <Property label="Gate">Only a person can do this</Property>
        )}
        {task.parent && (
          <Property label="Part of">
            <Link
              href={taskHref(task.parent.ref)}
              className="font-mono hover:underline"
            >
              {task.parent.ref}
            </Link>
          </Property>
        )}
        <Property label="Created">{formatDate(task.createdAt)}</Property>
      </dl>
      <section aria-labelledby="participants-title" className="space-y-2">
        <h2 id="participants-title" className="text-xs text-muted-foreground">
          Participants
        </h2>
        {parties.length > 0 && (
          <ul className="space-y-1.5 text-sm">
            {parties.map((party) => (
              <li key={party.id} className="flex items-start gap-2">
                <span className="min-w-0 flex-1 wrap-anywhere">
                  <span className="capitalize">{party.role}</span>:{" "}
                  {party.personPage ? (
                    <Link
                      href={pageHref(party.personPage.id)}
                      className="hover:underline"
                    >
                      {party.label}
                    </Link>
                  ) : party.kind === "owner" ? (
                    "you"
                  ) : (
                    party.label
                  )}
                  {party.sourceNote && (
                    <span className="block text-xs text-muted-foreground">
                      {party.sourceNote}
                    </span>
                  )}
                </span>
                <ActionButton
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove ${party.label} as ${party.role}`}
                  action={removePartyAction.bind(null, task.ref, party.id)}
                >
                  <X />
                </ActionButton>
              </li>
            ))}
          </ul>
        )}
        <PartyForm
          taskRef={task.ref}
          agents={choices.agents}
          people={{
            pages: people.pages.map(({ id, title }) => ({ id, title })),
            total: people.total,
          }}
        />
      </section>
      <section aria-labelledby="dependencies-title" className="space-y-2">
        <h2 id="dependencies-title" className="text-xs text-muted-foreground">
          Dependencies
        </h2>
        {detail.dependencies.blockedBy.length > 0 && (
          <ul className="space-y-1 text-sm">
            {detail.dependencies.blockedBy.map((item) => (
              <li key={item.ref} className="flex items-center gap-2">
                <Link
                  href={taskHref(item.ref)}
                  className="min-w-0 flex-1 wrap-anywhere hover:underline"
                >
                  <span className="font-mono text-xs">{item.ref}</span>{" "}
                  {item.title.value}
                </Link>
                <StatusBadge status={item.status} />
                <ActionButton
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Stop waiting for ${item.ref}`}
                  action={dependencyAction.bind(
                    null,
                    task.ref,
                    item.ref,
                    false,
                  )}
                >
                  <X />
                </ActionButton>
              </li>
            ))}
          </ul>
        )}
        {detail.dependencies.blocks.length > 0 && (
          <p className="text-sm text-muted-foreground">
            Blocks{" "}
            {detail.dependencies.blocks.map((item, index) => (
              <span key={item.ref}>
                {index > 0 && ", "}
                <Link
                  href={taskHref(item.ref)}
                  className="font-mono hover:underline"
                >
                  {item.ref}
                </Link>
              </span>
            ))}
          </p>
        )}
        <DependencyForm taskRef={task.ref} />
      </section>
      {detail.children.length > 0 && (
        <section aria-labelledby="subtasks-title" className="space-y-2">
          <h2 id="subtasks-title" className="text-xs text-muted-foreground">
            Subtasks
          </h2>
          <ul className="space-y-1 text-sm">
            {detail.children.map((child) => (
              <li key={child.ref} className="flex items-center gap-2">
                <Link
                  href={taskHref(child.ref)}
                  className="min-w-0 flex-1 wrap-anywhere hover:underline"
                >
                  <span className="font-mono text-xs">{child.ref}</span>{" "}
                  {child.title.value}
                </Link>
                <StatusBadge status={child.status} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

export async function TaskDangerZone({ params }: { params: TaskParams }) {
  const { task } = await readTaskDetail(params);
  return (
    <section
      aria-labelledby="danger-title"
      className="space-y-5 rounded-xl border border-destructive/30 p-5"
    >
      <h2 id="danger-title" className="font-medium">
        Archive or purge
      </h2>
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          {task.archivedAt
            ? "Archived tasks are hidden from lists, the board and agents."
            : "Archiving hides the task from lists, the board and agents; it stays recoverable."}
        </p>
        <ActionButton
          variant="outline"
          disabled={Boolean(task.claimedBy && task.leaseExpiresAt)}
          errorClassName="basis-full"
          action={taskOperationAction.bind(
            null,
            task.ref,
            task.archivedAt ? "unarchive" : "archive",
            { expectedVersion: task.version },
          )}
        >
          {task.archivedAt ? "Restore from archive" : "Archive"}
        </ActionButton>
      </div>
      <PurgeForm taskRef={task.ref} />
    </section>
  );
}
