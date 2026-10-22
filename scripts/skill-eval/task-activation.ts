import assert from "node:assert/strict";
import { alternatives } from "./activation";
import type { Scenario } from "./dataset";
import type { Bundle, Session } from "./evaluate";
import type { TaskWorld } from "./task-brain";
import { skillCatalog } from "./task-score";

// Two Brain skills compete with each other and with distractors in one
// frozen catalog: brain-tasks must load for tracked work only, and must not
// take loads away from brain-memory.

const TASKS = "brain-tasks/SKILL.md";
const MEMORY = "brain-memory/SKILL.md";
const distractors = [
  ...alternatives,
  {
    name: "work-planning",
    description:
      "Break a goal into steps or draft a work plan from the information the user provides.",
    body: "List concrete steps in a sensible order from the supplied goal and constraints. Mark assumptions. Do not claim that any step has been scheduled, assigned or done.",
  },
];

/** The candidate's Brain skills plus distractors; order is identical across arms. */
export function skillsActivationBundle(bundle: Bundle): Bundle {
  const brain = skillCatalog(bundle);
  assert(
    brain.some((s) => s.path === MEMORY),
    "brain-memory missing from the bundle",
  );
  const files = { ...bundle.files };
  const others = distractors.map((skill) => {
    const path = `${skill.name}/SKILL.md`;
    files[path] =
      `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body}\n`;
    return { name: skill.name, description: skill.description, path };
  });
  const memory = brain.find((s) => s.path === MEMORY);
  const tasks = brain.find((s) => s.path === TASKS);
  const catalog = [
    others[0],
    ...(memory ? [memory] : []),
    others[1],
    ...(tasks ? [tasks] : []),
    ...others.slice(2),
  ];
  files["mcp-instructions.md"] = bundle.instructions;
  return { files, instructions: bundle.instructions, catalog };
}

export function skillsActivationPrompt(
  request: string,
  bundle: Bundle,
  world: TaskWorld,
  command: string,
) {
  assert(bundle.catalog?.length, "Missing activation catalog");
  const agent = world.agents.find((a) => a.id === world.subjectId);
  assert(agent);
  return (
    `Complete the user's task. Use available capabilities when relevant; a direct answer without loading any skill or using any service is allowed.\n\n` +
    `This task uses an isolated local environment. Do not access external services, installed skills outside this catalog, the repository, parent folders, other sessions or evaluation files. Do not read or edit session.json. Use only the local command below for service actions and skill loading. These restrictions do not require any capability to be used.\n\n` +
    `Available skills (name, description and entrypoint):\n${JSON.stringify(bundle.catalog, null, 2)}\n\n` +
    `Local capability command: ${command} tool --name TOOL --input 'JSON_OBJECT'\n` +
    `Use read_skill {"path":"ENTRYPOINT_PATH"} to load a listed skill. For its linked references, resolve paths relative to that skill's folder. Input schemas are in tools.json beside this prompt. Use shell-quoted JSON or --input-file PATH; --batch-file PATH accepts sequential [{"tool":"NAME","input":{}}] calls.\n\n` +
    `Available service: Agent Brain, a synthetic personal knowledge store with knowledge pages and tracked tasks, connected as the agent "${agent.label}". Its page tools are context, resolve, search, read, related, list_pages, write and append; its task tools are list_tasks, read_task, create_task, update_task, claim_task, report_task, release_task and complete_task. Protocol instructions can be read with read_skill {"path":"mcp-instructions.md"}. Service availability does not imply relevance or permission to save.\n\n` +
    `When done, record the answer with ${command} finish --text 'ANSWER' (or --text-file PATH). If unable to finish, use finish --error 'REASON'. This recording command does not save user knowledge.\n\n` +
    `User task:\n${request}\n`
  );
}

type Outcome = "TP" | "FN" | "FP" | "TN" | null;
function outcome(
  expected: boolean | undefined,
  observed: boolean,
  complete: boolean,
): Outcome {
  if (expected === undefined || !complete) return null;
  if (expected) return observed ? "TP" : "FN";
  return observed ? "FP" : "TN";
}
const loaded = (session: Session, path: string) =>
  session.trace.findIndex(
    (t) =>
      t.tool === "read_skill" &&
      !t.error &&
      (t.input as { path?: string }).path === path,
  );

/** brain-tasks is the target; brain-memory is scored where a case fixes it. */
export function scoreSkillActivation(scenario: Scenario, session: Session) {
  assert(scenario.activation, "Missing activation expectation");
  const complete = session.status === "completed";
  const tasksAt = loaded(session, TASKS);
  const memoryAt = loaded(session, MEMORY);
  const brain = session.trace.filter((t) => t.tool !== "read_skill");
  return {
    expected: scenario.activation.shouldActivate,
    observed: tasksAt !== -1,
    outcome: outcome(
      scenario.activation.shouldActivate,
      tasksAt !== -1,
      complete,
    ),
    firstLoadCall: tasksAt === -1 ? null : tasksAt + 1,
    memoryExpected: scenario.activation.memory ?? null,
    memoryObserved: memoryAt !== -1,
    memoryOutcome: outcome(
      scenario.activation.memory,
      memoryAt !== -1,
      complete,
    ),
    brainCalls: brain.length,
    taskWrites: brain.filter(
      (t) =>
        !t.error &&
        [
          "create_task",
          "update_task",
          "claim_task",
          "report_task",
          "release_task",
          "complete_task",
        ].includes(t.tool),
    ).length,
    pageWrites: brain.filter((t) => t.mutation && !t.error).length,
    otherSkillsLoaded: [
      ...new Set(
        session.trace
          .filter(
            (t) =>
              t.tool === "read_skill" &&
              !t.error &&
              (t.input as { path?: string }).path?.endsWith("/SKILL.md") &&
              ![TASKS, MEMORY].includes((t.input as { path: string }).path),
          )
          .map((t) => (t.input as { path: string }).path),
      ),
    ],
  };
}

type Row = {
  caseId: string;
  variant: string;
  repeat: number;
  status: Session["status"] | "pending";
  skills: ReturnType<typeof scoreSkillActivation> | null;
};
function matrix(outcomes: Outcome[]) {
  const counts = { TP: 0, FN: 0, FP: 0, TN: 0 };
  for (const o of outcomes) if (o) counts[o]++;
  return counts;
}

export function skillActivationReport(rows: Row[], cases: Scenario[]) {
  const subsets = [
    "all",
    "development",
    "holdout",
    "explicit",
    "reference",
    "tracking",
    "handoff",
    "negative",
  ];
  const summaries = [...new Set(rows.map((r) => r.variant))].flatMap(
    (variant) =>
      subsets.map((subset) => {
        const ids = new Set(
          cases
            .filter(
              (c) =>
                subset === "all" ||
                c.group === subset ||
                c.activation?.category === subset,
            )
            .map((c) => c.id),
        );
        const selected = rows.filter(
          (r) => r.variant === variant && ids.has(r.caseId),
        );
        return {
          variant,
          subset,
          scheduled: selected.length,
          pending: selected.filter((r) => r.status === "pending").length,
          tasks: matrix(selected.map((r) => r.skills?.outcome ?? null)),
          memory: matrix(selected.map((r) => r.skills?.memoryOutcome ?? null)),
        };
      }),
  );
  const cell = (m: ReturnType<typeof matrix>) =>
    `${m.TP} | ${m.FN} | ${m.FP} | ${m.TN}`;
  const lines = [
    "## Two-skill activation (independent of semantic review)",
    "",
    "Activation means a successful read of brain-tasks/SKILL.md; brain-memory loads are scored only on cases that fix them. Incomplete trials are excluded. This is controlled catalog selection, not native client activation.",
    "",
    "| Arm | Subset | Scheduled | Pending | brain-tasks TP | FN | FP | TN | brain-memory TP | FN | FP | TN |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...summaries.map(
      (s) =>
        `| ${s.variant} | ${s.subset} | ${s.scheduled} | ${s.pending} | ${cell(s.tasks)} | ${cell(s.memory)} |`,
    ),
    "",
    "| Case | Arm | Repeat | Status | Expected | brain-tasks | Outcome | brain-memory | Memory outcome | Task writes | Page writes |",
    "| --- | --- | ---: | --- | --- | --- | --- | --- | --- | ---: | ---: |",
    ...rows.map((r) => {
      const s = r.skills;
      return `| ${r.caseId} | ${r.variant} | ${r.repeat} | ${r.status} | ${cases.find((c) => c.id === r.caseId)?.activation?.shouldActivate} | ${s?.observed ?? "pending"} | ${s?.outcome ?? "n/a"} | ${s?.memoryObserved ?? "pending"} | ${s?.memoryOutcome ?? "n/a"} | ${s?.taskWrites ?? "n/a"} | ${s?.pageWrites ?? "n/a"} |`;
    }),
    "",
  ];
  return { summaries, lines };
}
