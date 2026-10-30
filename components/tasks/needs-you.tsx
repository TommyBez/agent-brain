import { CheckCheck, Hand, ShieldCheck } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { taskOperationAction } from "@/app/(workspace)/actions/tasks";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty } from "@/components/workspace/primitives";
import { RelativeTime } from "@/components/workspace/relative-time";
import type { TaskRow } from "@/lib/workspace/task-queries";
import { taskHref, taskListHref } from "@/lib/workspace/task-urls";
import { getNeedsYou } from "@/lib/workspace/tasks-data";
import { ActionButton } from "./action-state";
import { LeaseCountdown } from "./lease-countdown";
import { QuestionForm } from "./question-form";
import { ReviewPanel } from "./review-panel";
import { AuthoredBy, PriorityLabel } from "./status";
import { SuggestionCard } from "./suggestion-card";
import { TriageBatch } from "./triage-batch";

function Section({
  id,
  title,
  description,
  count,
  shown = count,
  more,
  children,
}: {
  id: string;
  title: string;
  description: string;
  /** Every item of the section, including those not shown. */
  count: number;
  shown?: number;
  /** Where the rest of a long section is listed. */
  more?: string;
  children: ReactNode;
}) {
  if (!count) return null;
  return (
    <section aria-labelledby={id} className="space-y-4">
      <header>
        <h3 id={id} className="flex items-baseline gap-2 font-medium">
          {title}
          <span className="text-xs font-normal text-muted-foreground tabular-nums">
            {count}
          </span>
        </h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </header>
      {children}
      {shown < count && (
        <p className="text-sm text-muted-foreground">
          Showing the first {shown} of {count}, most urgent first.{" "}
          {more ? (
            <Link href={more} className="underline underline-offset-4">
              See them all in the table
            </Link>
          ) : (
            "Decide these to see the rest."
          )}
        </p>
      )}
    </section>
  );
}

function TaskCardHeader({
  task,
}: {
  task: Pick<TaskRow, "ref" | "title" | "priority">;
}) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {task.ref}
        </span>
        <Link
          href={taskHref(task.ref)}
          className="min-w-0 font-medium wrap-anywhere hover:underline"
        >
          {task.title.value}
        </Link>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
        <PriorityLabel priority={task.priority} />
        <AuthoredBy authored={task.title} />
      </div>
    </div>
  );
}

const card = "space-y-4 rounded-xl border bg-card p-4 sm:p-5";

export function NeedsYouSkeleton() {
  return (
    <output aria-label="Loading what needs you" className="block space-y-4">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-32" />
      <Skeleton className="h-32" />
    </output>
  );
}

/** Every decision that waits for the owner, grouped by kind. */
export async function NeedsYou() {
  const data = await getNeedsYou();
  const { totals } = data;
  const triageShown = data.triage.reduce(
    (sum, batch) => sum + batch.tasks.length,
    0,
  );
  const total =
    triageShown +
    data.questions.length +
    data.staleQuestions.length +
    data.reviews.length +
    data.humanSteps.length +
    data.onRequest.length +
    data.suggestions.length;
  if (!total)
    return (
      <Empty
        icon={<CheckCheck size={27} />}
        title="Nothing needs you"
        description="Approvals, questions from agents, reviews and suggestions appear here."
      />
    );
  const questionCard = (question: (typeof data.questions)[number]) => (
    <article
      key={question.task.id}
      id={`answer-${question.task.ref}`}
      className={card}
    >
      <TaskCardHeader task={question.task} />
      <QuestionForm
        taskRef={question.task.ref}
        version={question.task.version}
        inputRequestedAt={question.task.inputRequestedAt}
        prompt={question.prompt?.value ?? "The holder is waiting for you."}
        askedBy={question.askedBy}
        choices={question.choices}
        stale={question.stale}
      />
    </article>
  );
  return (
    <div className="space-y-10">
      <Section
        id="needs-you-triage"
        title="Triage"
        description="Tasks agents and the task keeper created. Approving one lets any suitable agent take it."
        count={totals.triage}
        shown={triageShown}
        more={taskListHref({ statuses: ["triage", "ready"] })}
      >
        <div className="space-y-4">
          {data.triage.map((batch) => (
            <TriageBatch key={batch.key} batch={batch} />
          ))}
        </div>
      </Section>
      <Section
        id="needs-you-questions"
        title="Questions"
        description="The holder keeps its claim and resumes once you answer."
        count={totals.questions}
        shown={data.questions.length}
        more={taskListHref({ statuses: ["needs_input"] })}
      >
        <div className="grid gap-4 xl:grid-cols-2">
          {data.questions.map(questionCard)}
        </div>
      </Section>
      <Section
        id="needs-you-reviews"
        title="Reviews"
        description="Completed work that waits for your approval."
        count={totals.reviews}
        shown={data.reviews.length}
        more={taskListHref({ statuses: ["in_review"] })}
      >
        <div className="grid gap-4 xl:grid-cols-2">
          {data.reviews.map((task) => (
            <article key={task.id} className={card}>
              <TaskCardHeader task={task} />
              <ReviewPanel task={task} />
            </article>
          ))}
        </div>
      </Section>
      <Section
        id="needs-you-human"
        title="Steps only a person can take"
        description="Blocked until you, or someone you ask, does this step."
        count={totals.humanSteps}
        shown={data.humanSteps.length}
        more={taskListHref({ statuses: ["blocked"] })}
      >
        <div className="grid gap-4 xl:grid-cols-2">
          {data.humanSteps.map((task) => (
            <article key={task.id} className={card}>
              <TaskCardHeader task={task} />
              {task.statusNote && (
                <div className="space-y-1">
                  <p className="text-sm whitespace-pre-wrap wrap-anywhere">
                    {task.statusNote.value}
                  </p>
                  <AuthoredBy authored={task.statusNote} />
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <ActionButton
                  size="sm"
                  variant="outline"
                  errorClassName="basis-full"
                  action={taskOperationAction.bind(null, task.ref, "unblock", {
                    expectedVersion: task.version,
                  })}
                >
                  <Hand aria-hidden="true" /> Step done, unblock
                </ActionButton>
                <ActionButton
                  size="sm"
                  variant="ghost"
                  errorClassName="basis-full"
                  action={taskOperationAction.bind(null, task.ref, "close", {
                    expectedVersion: task.version,
                  })}
                >
                  Mark the task done
                </ActionButton>
              </div>
            </article>
          ))}
        </div>
      </Section>
      <Section
        id="needs-you-on-request"
        title="Claimed on your request"
        description="Agents that said you asked them to take a task. Revoke it if you did not."
        count={totals.onRequest}
        shown={data.onRequest.length}
        more={taskListHref({ statuses: ["in_progress", "needs_input"] })}
      >
        <div className="grid gap-4 xl:grid-cols-2">
          {data.onRequest.map((item) => (
            <article key={item.task.id} className={card}>
              <TaskCardHeader task={item.task} />
              <p className="text-sm wrap-anywhere">
                <ShieldCheck
                  size={15}
                  aria-hidden="true"
                  className="mr-1 inline text-muted-foreground"
                />
                {item.task.claimedBy?.label ?? "An agent"} quotes you: “
                {item.quote.value}”
              </p>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {item.task.leaseExpiresAt && (
                  <LeaseCountdown expiresAt={item.task.leaseExpiresAt} />
                )}
                {item.leads.length > 0 && (
                  <span>Lead: {item.leads.join(", ")}</span>
                )}
                {item.claimedAt && (
                  <span>
                    Claimed <RelativeTime value={item.claimedAt} />
                  </span>
                )}
              </div>
              <ActionButton
                size="sm"
                variant="outline"
                errorClassName="basis-full"
                action={taskOperationAction.bind(
                  null,
                  item.task.ref,
                  "release",
                  {
                    expectedVersion: item.task.version,
                    claimCount: item.task.claimCount,
                  },
                )}
              >
                Revoke
              </ActionButton>
            </article>
          ))}
        </div>
      </Section>
      <Section
        id="needs-you-stale"
        title="Questions waiting more than 7 days"
        description="After 14 days another agent may take the task over, with the question in its brief."
        count={totals.staleQuestions}
        shown={data.staleQuestions.length}
        more={taskListHref({ statuses: ["needs_input"] })}
      >
        <div className="grid gap-4 xl:grid-cols-2">
          {data.staleQuestions.map(questionCard)}
        </div>
      </Section>
      <Section
        id="needs-you-suggestions"
        title="Suggestions"
        description="Nightly maintenance noticed these. Nothing changes until you accept."
        count={totals.suggestions}
        shown={data.suggestions.length}
      >
        <div className="grid gap-4 xl:grid-cols-2">
          {data.suggestions.map((suggestion) => (
            <SuggestionCard key={suggestion.id} suggestion={suggestion} />
          ))}
        </div>
      </Section>
    </div>
  );
}
