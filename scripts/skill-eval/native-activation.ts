import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// These tasks are delivered verbatim through spawn_agent, without a harness prompt.
// Expectations and IDs must remain with the evaluator.
export const nativeCases = [
  {
    id: "P01",
    category: "proactive",
    expected: true,
    request:
      "Da questo mese, nella mia attività di consulenza, accetto nuovi incarichi solo se prevedono almeno tre mesi di collaborazione: i progetti più brevi mi fanno spendere troppo tempo in onboarding rispetto al lavoro utile. Aiutami a formulare in modo cordiale una risposta a un potenziale cliente che chiede un intervento di due settimane. Prepara soltanto la bozza qui in chat, senza inviare messaggi né modificare file o servizi.",
    rationale:
      "New durable professional rule with rationale, encountered while drafting an answer; no stored context needed.",
  },
  {
    id: "P02",
    category: "proactive",
    expected: true,
    request:
      "Ho cambiato il modo in cui valuto i nuovi prodotti della mia venture studio: prima di investire nello sviluppo voglio sempre almeno cinque interviste con potenziali clienti e due impegni concreti a pagare. Le manifestazioni generiche di interesse finora mi hanno tratto in inganno. Trasforma questa regola in una breve checklist da usare quando analizzo un'idea. Lavora soltanto qui in chat, senza modificare file o servizi.",
    rationale:
      "New durable investment criterion with thresholds and rationale; producing a checklist requires no retrieval.",
  },
  {
    id: "N01",
    category: "negative",
    expected: false,
    request:
      "Traduci in inglese questa frase tratta da un romanzo: «Da questo mese, nella mia attività di consulenza, accetto nuovi incarichi solo se prevedono almeno tre mesi di collaborazione». Lavora soltanto qui in chat, senza modificare file o servizi.",
    rationale:
      "Same vocabulary as P01 but explicitly fictional, not information about the user.",
  },
  {
    id: "C01",
    category: "explicit",
    expected: true,
    request:
      "Usa la skill agent-brain:brain-memory per valutare se questa informazione sulla mia attività sia utile da conservare: da questo mese accetto nuovi incarichi di consulenza solo se durano almeno tre mesi, perché gli incarichi più brevi comportano troppo onboarding rispetto al lavoro utile. Non salvare nulla e non modificare file o servizi: dimmi soltanto cosa proporresti di conservare.",
    rationale:
      "Positive availability control, distinct from spontaneous activation.",
  },
  {
    id: "P03",
    category: "proactive",
    expected: true,
    request:
      "Per il nuovo servizio di analisi documentale ho deciso che tutti i documenti dei clienti devono restare in data center nell'Unione Europea, compresi i backup: due clienti ci hanno già detto che è un requisito per acquistare. Aiutami a scrivere una breve spiegazione di questa scelta da mettere sotto il campo di caricamento dei file. Lavora soltanto qui in chat, senza modificare file o servizi.",
    rationale:
      "Confirmed product constraint and its commercial rationale emerge during a microcopy task; the task is self-contained.",
  },
  {
    id: "N02",
    category: "negative",
    expected: false,
    request:
      "Sto aspettando il treno e ho venticinque minuti liberi. Suggeriscimi come dividerli tra leggere qualche pagina del libro che ho con me e fare due passi in stazione. Lavora soltanto qui in chat, senza modificare file o servizi.",
    rationale:
      "Transient circumstance and one-off scheduling, not a durable preference or rule.",
  },
];

export function validateNativeCases(
  cases: unknown,
): asserts cases is typeof nativeCases {
  assert(
    Array.isArray(cases) && cases.length > 0,
    "Expected nonempty native cases",
  );
  const ids = new Set<string>();
  for (const c of cases) {
    assert(c && typeof c === "object");
    assert(
      typeof c.id === "string" &&
        /^[A-Za-z0-9_-]+$/.test(c.id) &&
        !ids.has(c.id),
      "Invalid or duplicate case ID",
    );
    ids.add(c.id);
    assert(
      ["proactive", "implicit", "explicit", "negative"].includes(c.category),
      "Invalid native category",
    );
    assert(
      typeof c.expected === "boolean",
      "Expected activation must be boolean",
    );
    assert(
      typeof c.request === "string" && c.request.trim(),
      "Missing native request",
    );
    assert(
      typeof c.rationale === "string" && c.rationale.trim(),
      "Missing expectation rationale",
    );
  }
}

type Event = { type: string; payload: Record<string, unknown> };
type Snapshot = { path: string; content: string };
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const json = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, "utf8"));
const save = (path: string, value: unknown) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });

function texts(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      return [value, ...texts(JSON.parse(value))];
    } catch {
      return [value];
    }
  }
  if (Array.isArray(value)) return value.flatMap(texts);
  if (value && typeof value === "object")
    return Object.values(value).flatMap(texts);
  return [];
}

export function parseNativeRollout(
  raw: string,
  skill: Snapshot,
  model: string,
  reasoningEffort?: string,
) {
  const events = raw
    .trim()
    .split("\n")
    .map((line): Event => JSON.parse(line));
  const meta = events[0];
  assert.equal(
    meta.type,
    "session_meta",
    "Expected a Codex rollout, not model self-report",
  );
  const parent = (
    meta.payload.source as {
      subagent?: { thread_spawn?: { parent_thread_id?: string } };
    }
  )?.subagent?.thread_spawn?.parent_thread_id;
  assert(parent, "Expected a native subagent rollout");
  const turns = events.filter((e) => e.type === "turn_context");
  assert.equal(turns.length, 1, "Use a fresh agent with exactly one turn");
  assert.equal(turns[0].payload.model, model, "Executor model mismatch");
  if (reasoningEffort !== undefined)
    assert.equal(
      turns[0].payload.effort,
      reasoningEffort,
      "Executor reasoning effort mismatch",
    );
  const messages = events.filter((e) => e.type === "response_item");
  const instructions = messages
    .filter((e) => e.payload.role === "developer")
    .flatMap((e) => texts(e.payload.content))
    .join("\n");
  const description = skill.content.match(/^description: (.+)$/m)?.[1];
  const skillName = skill.content.match(/^name: (.+)$/m)?.[1];
  assert(description);
  assert(skillName, "Missing target skill name");
  const catalogLine = instructions
    .split("\n")
    .find(
      (line) =>
        line.startsWith(`- agent-brain:${skillName}:`) &&
        line.includes(description),
    );
  assert(catalogLine, "Target skill metadata missing from native catalog");
  const listedPath = catalogLine.match(/\(file: (.+)\)$/)?.[1];
  assert(listedPath, "Missing catalog path");
  const roots = [...instructions.matchAll(/- `([^`]+)` = `([^`]+)`/g)];
  const resolvedPath = roots.reduce(
    (path, match) =>
      path.startsWith(`${match[1]}/`)
        ? `${match[2]}/${path.slice(match[1].length + 1)}`
        : path,
    listedPath,
  );
  assert.equal(
    resolvedPath,
    skill.path,
    "Installed skill differs from prepared target",
  );
  const intro = skill.content.split(/\r?\n\r?\n/)[2];
  assert(intro?.length > 60, "Expected an identifiable skill introduction");
  assert(
    !instructions.includes(intro),
    "Skill body was already loaded in instructions",
  );
  const calls = messages.filter((e) =>
    ["custom_tool_call", "function_call"].includes(String(e.payload.type)),
  );
  const outputs = messages.filter((e) =>
    ["custom_tool_call_output", "function_call_output"].includes(
      String(e.payload.type),
    ),
  );
  const evidence = calls.flatMap((call) => {
    const source = String(call.payload.input ?? call.payload.arguments ?? "");
    // A requested read alone is insufficient. The paired output must contain the body.
    if (!source.includes(`${skillName}/SKILL.md`)) return [];
    const output = outputs.find(
      (e) => e.payload.call_id === call.payload.call_id,
    );
    if (!output || !texts(output.payload.output).some((s) => s.includes(intro)))
      return [];
    return [
      {
        callId: call.payload.call_id,
        callLine: events.indexOf(call) + 1,
        outputLine: events.indexOf(output) + 1,
      },
    ];
  });
  const complete = events.some(
    (e) => e.type === "event_msg" && e.payload.type === "task_complete",
  );
  const final = messages
    .filter(
      (e) =>
        e.payload.role === "assistant" && e.payload.phase === "final_answer",
    )
    .flatMap((e) => texts(e.payload.content))
    .filter((s) => s !== "output_text")
    .join("\n");
  const completion = events.find(
    (e) => e.type === "event_msg" && e.payload.type === "task_complete",
  );
  return {
    sessionId: String(meta.payload.id),
    parentSessionId: parent,
    agent: String(meta.payload.agent_path),
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    completed: complete,
    catalogLine,
    catalogHash: digest(instructions.slice(instructions.indexOf("## Skills"))),
    toolCalls: calls.length,
    loaded: evidence.length > 0,
    loadEvidence: evidence,
    final: String(completion?.payload.last_agent_message ?? final),
    // Review these sources for unsupported reads or mutations; do not infer writes from tool discovery.
    toolSources: calls.map((e) => ({
      callId: e.payload.call_id,
      source: e.payload.input ?? e.payload.arguments,
      name: e.payload.name,
    })),
  };
}

export function verifyDispatch(
  raw: string,
  agent: string,
  request: string,
  model: string,
  parent: string,
) {
  const events = raw
    .trim()
    .split("\n")
    .map((line): Event => JSON.parse(line));
  assert.equal(
    events[0].payload.id,
    parent,
    "Dispatch belongs to a different parent",
  );
  const calls = events
    .filter(
      (e) =>
        e.type === "response_item" &&
        e.payload.type === "function_call" &&
        e.payload.name === "spawn_agent",
    )
    .map((event) => ({
      event,
      args: JSON.parse(String(event.payload.arguments)) as Record<
        string,
        unknown
      >,
    }))
    .filter(({ args }) => agent.endsWith(`/${args.task_name}`));
  assert.equal(
    calls.length,
    1,
    "Missing or ambiguous parent dispatch evidence",
  );
  const encrypted =
    typeof calls[0].args.message === "string" &&
    /^gAAAAA[A-Za-z0-9_-]+={0,2}$/.test(calls[0].args.message);
  if (!encrypted)
    assert.equal(
      calls[0].args.message,
      request,
      "Dispatch did not use the frozen task verbatim",
    );
  assert.equal(calls[0].args.model, model);
  assert.equal(
    calls[0].args.fork_turns,
    "none",
    "Parent history must not be inherited",
  );
  return {
    evidence: [events[0], calls[0].event]
      .map((e) => JSON.stringify(e))
      .join("\n"),
    promptVerification: encrypted
      ? ("manual-encrypted" as const)
      : ("exact" as const),
  };
}

type Manifest = {
  version: 1;
  model: string;
  reasoningEffort?: string;
  skill: Snapshot;
  cases: typeof nativeCases;
  preparedAt: string;
  frozenHash: string;
  harnessHash: string;
  trials: { id: string; caseId: string; repeat: number }[];
};
const frozen = ({
  model,
  reasoningEffort,
  skill,
  cases,
  trials,
  preparedAt,
}: Manifest) => ({
  model,
  ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  skill,
  cases,
  trials,
  preparedAt,
});
type Observation = ReturnType<typeof parseNativeRollout> & {
  trialId: string;
  rolloutHash: string;
  dispatchHash: string;
  promptVerification: "exact" | "manual-encrypted";
  review: {
    proposedMemory: boolean;
    evidence: string;
    noWrites: boolean;
    dispatchMatchesFrozenPrompt?: boolean;
  };
};

export async function nativeCommand(
  command: string,
  v: Record<string, string | undefined>,
) {
  const required = (key: string) => {
    assert(v[key], `Missing --${key}`);
    return v[key];
  };
  const source = await readFile(import.meta.filename, "utf8");
  if (command === "native-prepare") {
    const dir = resolve(required("out"));
    const skill = {
      path: resolve(required("skill-file")),
      content: await readFile(required("skill-file"), "utf8"),
    };
    const repeats = Number(v.repeats ?? 3);
    assert(Number.isSafeInteger(repeats) && repeats > 0 && repeats <= 20);
    const cases: unknown = v["cases-file"]
      ? await json(v["cases-file"])
      : nativeCases;
    validateNativeCases(cases);
    const reasoningEffort = v["reasoning-effort"];
    if (reasoningEffort !== undefined)
      assert(
        [
          "none",
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
          "ultra",
        ].includes(reasoningEffort),
        "Invalid --reasoning-effort",
      );
    const trials: Manifest["trials"] = [];
    for (let repeat = 1; repeat <= repeats; repeat++)
      for (const c of cases)
        trials.push({ id: randomUUID(), caseId: c.id, repeat });
    const manifest: Manifest = {
      version: 1,
      model: v.model ?? "gpt-6.1-sol",
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      skill,
      cases,
      preparedAt: new Date().toISOString(),
      frozenHash: "",
      harnessHash: digest(source),
      trials,
    };
    manifest.frozenHash = digest(frozen(manifest));
    await mkdir(dir, { recursive: false });
    await save(join(dir, "manifest.json"), manifest);
    await writeFile(join(dir, "harness-source.ts"), source, { flag: "wx" });
    console.log(
      JSON.stringify({
        directory: dir,
        trials: trials.length,
        model: manifest.model,
        reasoningEffort: manifest.reasoningEffort ?? "not frozen",
        skill: skill.path,
      }),
    );
    return;
  }
  const dir = resolve(required("run"));
  const manifest = await json<Manifest>(join(dir, "manifest.json"));
  assert.equal(manifest.version, 1);
  validateNativeCases(manifest.cases);
  assert.equal(
    manifest.frozenHash,
    digest(frozen(manifest)),
    "Frozen inputs changed",
  );
  type Repair = {
    originalHash: string;
    currentHash: string;
    frozenHash: string;
    reason: string;
  };
  let repair: Repair | null = null;
  if (command === "native-repair-observer") {
    assert.notEqual(
      manifest.harnessHash,
      digest(source),
      "Observer is unchanged",
    );
    assert.equal(
      digest(await readFile(join(dir, "harness-source.ts"), "utf8")),
      manifest.harnessHash,
    );
    await save(join(dir, "observer-repair.json"), {
      originalHash: manifest.harnessHash,
      currentHash: digest(source),
      frozenHash: manifest.frozenHash,
      reason: required("reason"),
    });
    await writeFile(join(dir, "observer-repaired.ts"), source, { flag: "wx" });
    console.log(
      "Observer repair recorded; original snapshots and all trials retained.",
    );
    return;
  }
  if (manifest.harnessHash !== digest(source)) {
    repair = await json<Repair>(join(dir, "observer-repair.json"));
    assert.equal(repair.originalHash, manifest.harnessHash);
    assert.equal(
      repair.currentHash,
      digest(source),
      "Unrecorded observer change",
    );
    assert.equal(repair.frozenHash, manifest.frozenHash);
  }
  if (command === "native-record") {
    const trial = manifest.trials.find((t) => t.id === required("trial"));
    assert(trial, "Unknown trial");
    const scenario = manifest.cases.find((c) => c.id === trial.caseId);
    assert(scenario);
    assert.equal(
      await readFile(manifest.skill.path, "utf8"),
      manifest.skill.content,
      "Installed skill changed",
    );
    const raw = await readFile(required("rollout"), "utf8");
    const dispatch = await readFile(required("dispatch-rollout"), "utf8");
    const observation = parseNativeRollout(
      raw,
      manifest.skill,
      manifest.model,
      manifest.reasoningEffort,
    );
    const dispatchEvidence = verifyDispatch(
      dispatch,
      observation.agent,
      scenario.request,
      manifest.model,
      observation.parentSessionId,
    );
    const started = JSON.parse(raw.split("\n")[0]).timestamp;
    assert(
      Date.parse(started) >= Date.parse(manifest.preparedAt),
      "Exploratory probes before preparation are not scheduled trials",
    );
    for (const other of manifest.trials.filter((t) => t.id !== trial.id)) {
      try {
        const old = await json<Observation>(join(dir, `${other.id}.json`));
        assert.notEqual(
          old.sessionId,
          observation.sessionId,
          "Session reused across trials",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const review = await json<Observation["review"]>(required("review-file"));
    assert.equal(typeof review.proposedMemory, "boolean");
    assert.equal(typeof review.noWrites, "boolean");
    if (dispatchEvidence.promptVerification === "manual-encrypted")
      assert.equal(
        review.dispatchMatchesFrozenPrompt,
        true,
        "Encrypted dispatch requires an explicit evaluator check against the actual spawn_agent call",
      );
    assert(
      typeof review.evidence === "string" && review.evidence.trim(),
      "Review needs evidence",
    );
    if (review.proposedMemory)
      assert(
        observation.final.includes(review.evidence),
        "Proposal evidence must quote the answer",
      );
    // Keep raw evidence local; it may include private context from read-only calls.
    await writeFile(join(dir, `${trial.id}.rollout.jsonl`), raw, {
      flag: "wx",
    });
    await writeFile(
      join(dir, `${trial.id}.dispatch.jsonl`),
      dispatchEvidence.evidence,
      {
        flag: "wx",
      },
    );
    await save(join(dir, `${trial.id}.json`), {
      ...observation,
      trialId: trial.id,
      rolloutHash: digest(raw),
      dispatchHash: digest(dispatchEvidence.evidence),
      promptVerification: dispatchEvidence.promptVerification,
      review,
    });
    console.log(
      JSON.stringify({
        trial: trial.id,
        loaded: observation.loaded,
        completed: observation.completed,
      }),
    );
    return;
  }
  assert.equal(command, "native-report", "Unknown native command");
  const rows: (Manifest["trials"][number] & {
    category: string;
    expected: boolean;
    observation: Observation | null;
    outcome: "TP" | "FN" | "FP" | "TN" | null;
  })[] = [];
  const sessions = new Set<string>();
  for (const trial of manifest.trials) {
    const scenario = manifest.cases.find((c) => c.id === trial.caseId);
    assert(scenario);
    let observation: Observation | null = null;
    try {
      observation = await json<Observation>(join(dir, `${trial.id}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (observation) {
      const raw = await readFile(
        join(dir, `${trial.id}.rollout.jsonl`),
        "utf8",
      );
      assert.equal(
        digest(raw),
        observation.rolloutHash,
        "Rollout evidence changed",
      );
      const replay = parseNativeRollout(
        raw,
        manifest.skill,
        manifest.model,
        manifest.reasoningEffort,
      );
      const dispatch = await readFile(
        join(dir, `${trial.id}.dispatch.jsonl`),
        "utf8",
      );
      assert.equal(
        digest(dispatch),
        observation.dispatchHash,
        "Dispatch evidence changed",
      );
      const checkedDispatch = verifyDispatch(
        dispatch,
        replay.agent,
        scenario.request,
        manifest.model,
        replay.parentSessionId,
      );
      assert.equal(
        checkedDispatch.promptVerification,
        observation.promptVerification,
      );
      if (checkedDispatch.promptVerification === "manual-encrypted")
        assert.equal(observation.review.dispatchMatchesFrozenPrompt, true);
      for (const key of Object.keys(replay) as (keyof typeof replay)[])
        assert.deepEqual(
          observation[key],
          replay[key],
          `Observation mismatch: ${key}`,
        );
      assert(
        !sessions.has(observation.sessionId),
        "Session reused across trials",
      );
      sessions.add(observation.sessionId);
    }
    rows.push({
      ...trial,
      category: scenario.category,
      expected: scenario.expected,
      observation,
      outcome: observation?.completed
        ? scenario.expected
          ? observation.loaded
            ? "TP"
            : "FN"
          : observation.loaded
            ? "FP"
            : "TN"
        : null,
    });
  }
  const categories = [
    "all",
    "proactive",
    ...(manifest.cases.some((c) => c.category === "implicit")
      ? ["implicit"]
      : []),
    "explicit",
    "negative",
  ];
  const summaries = categories.map((category) => {
    const selected = rows.filter(
      (r) => category === "all" || r.category === category,
    );
    return {
      category,
      scheduled: selected.length,
      completed: selected.filter((r) => r.outcome).length,
      pending: selected.filter((r) => !r.observation).length,
      incomplete: selected.filter((r) => r.observation && !r.outcome).length,
      TP: selected.filter((r) => r.outcome === "TP").length,
      FN: selected.filter((r) => r.outcome === "FN").length,
      FP: selected.filter((r) => r.outcome === "FP").length,
      TN: selected.filter((r) => r.outcome === "TN").length,
      proposed: selected.filter(
        (r) => r.observation?.completed && r.observation.review.proposedMemory,
      ).length,
      writeViolations: selected.filter(
        (r) => r.observation && !r.observation.review.noWrites,
      ).length,
    };
  });
  const lines = [
    "# Native subagent activation",
    "",
    `Model: ${manifest.model}. Installed skill: ${manifest.skill.path}.`,
    `Reasoning effort: ${manifest.reasoningEffort ?? "not frozen (legacy run)"}.`,
    "",
    "Fresh subagents with the native catalog; the harness adds no catalog or evaluation instructions to the task. The client may still inject global instructions and user memory despite fork_turns:none. Counts measure skill loading, separately from manually reviewed proposals. Task scope and restrictions are defined by the frozen cases. This does not measure authorized persistence or full desktop conversations; information from tool results is covered only when included in those cases.",
    `Prompt checks: ${rows.filter((r) => r.observation?.promptVerification === "exact").length} exact; ${rows.filter((r) => r.observation?.promptVerification === "manual-encrypted").length} manually checked because the runtime encrypted the dispatch text.`,
    ...(repair ? [`Observer repair: ${repair.reason}`] : []),
    "",
    "| Category | Scheduled | Completed | Pending | Incomplete | TP | FN | FP | TN | Proposals | Write violations |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...summaries.map(
      (s) =>
        `| ${s.category} | ${s.scheduled} | ${s.completed} | ${s.pending} | ${s.incomplete} | ${s.TP} | ${s.FN} | ${s.FP} | ${s.TN} | ${s.proposed} | ${s.writeViolations} |`,
    ),
    "",
    "| Case | Repeat | Outcome | Loaded | Proposed | Tool calls |",
    "| --- | ---: | --- | --- | --- | ---: |",
    ...rows.map(
      (r) =>
        `| ${r.caseId} | ${r.repeat} | ${r.outcome ?? "unscored"} | ${r.observation?.loaded ?? "pending"} | ${r.observation?.review.proposedMemory ?? "pending"} | ${r.observation?.toolCalls ?? "pending"} |`,
    ),
    "",
  ];
  await writeFile(join(dir, "report.md"), lines.join("\n"));
  await writeFile(
    join(dir, "results.json"),
    `${JSON.stringify({ summaries, rows }, null, 2)}\n`,
  );
  console.log(JSON.stringify(summaries, null, 2));
}
