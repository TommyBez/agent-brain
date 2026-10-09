import assert from "node:assert/strict";
import type { Scenario } from "./dataset";
import type { Bundle, Session } from "./evaluate";

const entrypoint = "brain-memory/SKILL.md";
const alternatives = [
  {
    name: "text-editing",
    description:
      "Translate, proofread or rewrite text supplied by the user while preserving its meaning.",
    body: "Work from the supplied text. Follow the requested language, tone and scope. Do not add outside facts. Return the edited text unless an explanation was requested.",
  },
  {
    name: "code-explanation",
    description:
      "Explain a supplied code snippet or propose a small correction to an isolated programming error.",
    body: "Read the supplied snippet, identify the relevant behavior or error and provide a focused explanation or correction. Do not claim to have run code you have not run.",
  },
  {
    name: "document-outline",
    description:
      "Organize a proposal, meeting agenda or handover document from the available information.",
    body: "Produce a concise outline appropriate to the user's purpose. Distinguish available information from assumptions. Consult other relevant capabilities if essential context is missing.",
  },
];

/** Namespaced files and competing skills are frozen inside each experiment bundle. */
export function activationBundle(bundle: Bundle): Bundle {
  const metadata = bundle.files["SKILL.md"].match(
    /^---\r?\n([\s\S]*?)\r?\n---/,
  );
  assert(metadata, "Missing skill metadata");
  const name = metadata[1].match(/^name: (.+)$/m)?.[1]?.trim();
  const description = metadata[1].match(/^description: (.+)$/m)?.[1]?.trim();
  assert.equal(name, "brain-memory");
  assert(
    description,
    "A single-line description is required for activation evals",
  );
  const files = Object.fromEntries(
    Object.entries(bundle.files).map(([path, content]) => [
      `brain-memory/${path}`,
      content,
    ]),
  );
  const catalog: NonNullable<Bundle["catalog"]> = alternatives.map((skill) => {
    const path = `${skill.name}/SKILL.md`;
    files[path] =
      `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body}\n`;
    return { name: skill.name, description: skill.description, path };
  });
  // Brain is not always the first catalog entry. The order stays identical across arms.
  catalog.splice(1, 0, { name, description, path: entrypoint });
  files["brain-memory/mcp-instructions.md"] = bundle.instructions;
  return { files, instructions: bundle.instructions, catalog };
}

export function activationPrompt(
  request: string,
  bundle: Bundle,
  command: string,
) {
  assert(bundle.catalog?.length, "Missing activation catalog");
  return (
    `Complete the user's task. Use available capabilities when relevant; a direct answer without loading any skill or using any service is allowed.\n\n` +
    `This task uses an isolated local environment. Do not access external services, installed skills outside this catalog, the repository, parent folders, other sessions or evaluation files. Do not read or edit session.json. Use only the local command below for service actions and skill loading. These restrictions do not require any capability to be used.\n\n` +
    `Available skills (name, description and entrypoint):\n${JSON.stringify(bundle.catalog, null, 2)}\n\n` +
    `Local capability command: ${command} tool --name TOOL --input 'JSON_OBJECT'\n` +
    `Use read_skill {"path":"ENTRYPOINT_PATH"} to load a listed skill. For its linked references, resolve paths relative to that skill's folder. Input schemas are in tools.json beside this prompt. Use shell-quoted JSON or --input-file PATH; --batch-file PATH accepts sequential [{"tool":"NAME","input":{}}] calls.\n\n` +
    `Available service: Brain, a synthetic personal knowledge store. Its tools are context, resolve, search, read, related, list_pages, write and append. Protocol instructions can be read with read_skill {"path":"brain-memory/mcp-instructions.md"}. Service availability does not imply relevance or permission to save.\n\n` +
    `When done, record the answer with ${command} finish --text 'ANSWER' (or --text-file PATH). If unable to finish, use finish --error 'REASON'. This recording command does not save user knowledge.\n\n` +
    `User task:\n${request}\n`
  );
}

export function scoreActivation(scenario: Scenario, session: Session) {
  assert(scenario.activation, "Missing activation expectation");
  const firstLoad = session.trace.findIndex(
    (t) =>
      t.tool === "read_skill" &&
      !t.error &&
      (t.input as { path?: string }).path === entrypoint,
  );
  const observed = firstLoad !== -1;
  const expected = scenario.activation.shouldActivate;
  const complete = session.status === "completed";
  const brain = session.trace.filter((t) => t.tool !== "read_skill");
  const outcome: "TP" | "FN" | "FP" | "TN" | null = complete
    ? expected
      ? observed
        ? "TP"
        : "FN"
      : observed
        ? "FP"
        : "TN"
    : null;
  return {
    expected,
    observed,
    // Never classify an interrupted run as a true negative or a false negative.
    outcome,
    firstLoadCall: observed ? firstLoad + 1 : null,
    brainCalls: brain.length,
    successfulBrainCalls: brain.filter((t) => !t.error).length,
    brainCallsBeforeLoad: session.trace
      .slice(0, observed ? firstLoad : undefined)
      .filter((t) => t.tool !== "read_skill").length,
    attemptedWrites: brain.filter(
      (t) => t.tool === "write" || t.tool === "append",
    ).length,
    successfulWrites: brain.filter((t) => t.mutation && !t.error).length,
    otherSkillsLoaded: [
      ...new Set(
        session.trace
          .filter(
            (t) =>
              t.tool === "read_skill" &&
              !t.error &&
              (t.input as { path?: string }).path?.endsWith("/SKILL.md") &&
              (t.input as { path?: string }).path !== entrypoint,
          )
          .map((t) => (t.input as { path: string }).path),
      ),
    ],
  };
}

type ActivationRow = {
  caseId: string;
  variant: string;
  repeat: number;
  status: Session["status"] | "pending";
  activation: ReturnType<typeof scoreActivation> | null;
};

export function activationSummary(rows: ActivationRow[]) {
  const counts = { TP: 0, FN: 0, FP: 0, TN: 0 };
  for (const row of rows) {
    const outcome = row.activation?.outcome;
    if (outcome) counts[outcome]++;
  }
  const completed = Object.values(counts).reduce((n, v) => n + v, 0);
  const rate = (n: number, d: number) => (d ? n / d : null);
  return {
    scheduled: rows.length,
    completed,
    pending: rows.filter((r) => r.status === "pending").length,
    incomplete: rows.filter(
      (r) => r.status !== "completed" && r.status !== "pending",
    ).length,
    ...counts,
    precision: rate(counts.TP, counts.TP + counts.FP),
    recall: rate(counts.TP, counts.TP + counts.FN),
    falsePositiveRate: rate(counts.FP, counts.FP + counts.TN),
    accuracy: rate(counts.TP + counts.TN, completed),
  };
}

export function activationReport(rows: ActivationRow[], cases: Scenario[]) {
  const subsets = [
    "all",
    "development",
    "holdout",
    "explicit",
    "retrieval",
    "memory",
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
        return {
          variant,
          subset,
          ...activationSummary(
            rows.filter((r) => r.variant === variant && ids.has(r.caseId)),
          ),
        };
      }),
  );
  const percentage = (n: number | null) =>
    n === null ? "n/a" : `${(100 * n).toFixed(1)}%`;
  const lines = [
    "## Activation (independent of semantic review)",
    "",
    "Activation means a successful read of brain-memory/SKILL.md. Brain calls alone, reading references or declaring skill use do not count. Incomplete trials are excluded from the confusion matrix; pending/incomplete counts remain visible. This is controlled catalog selection, not native client activation. Subsequent calls are observations, not evidence of task correctness.",
    "",
    "| Arm | Subset | Scheduled | Completed | Pending | Incomplete | TP | FN | FP | TN | Precision | Recall | False positive rate | Accuracy |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...summaries.map(
      (s) =>
        `| ${s.variant} | ${s.subset} | ${s.scheduled} | ${s.completed} | ${s.pending} | ${s.incomplete} | ${s.TP} | ${s.FN} | ${s.FP} | ${s.TN} | ${percentage(s.precision)} | ${percentage(s.recall)} | ${percentage(s.falsePositiveRate)} | ${percentage(s.accuracy)} |`,
    ),
    "",
    "| Case | Arm | Repeat | Status | Expected | Loaded | Outcome | First load call | Brain calls | Before load | Write attempts | Writes |",
    "| --- | --- | ---: | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map((r) => {
      const a = r.activation;
      const expected = cases.find((c) => c.id === r.caseId)?.activation
        ?.shouldActivate;
      return `| ${r.caseId} | ${r.variant} | ${r.repeat} | ${r.status} | ${expected} | ${a?.observed ?? "pending"} | ${a?.outcome ?? "pending"} | ${a?.firstLoadCall ?? "n/a"} | ${a?.brainCalls ?? "n/a"} | ${a?.brainCallsBeforeLoad ?? "n/a"} | ${a?.attemptedWrites ?? "n/a"} | ${a?.successfulWrites ?? "n/a"} |`;
    }),
    "",
  ];
  return { summaries, lines };
}
