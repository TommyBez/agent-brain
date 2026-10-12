import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  nativeCases,
  nativeCommand,
  parseNativeRollout,
  validateNativeCases,
  verifyDispatch,
} from "../scripts/skill-eval/native-activation";

const skill = {
  path: "/installed/brain-memory/SKILL.md",
  content:
    "---\nname: brain-memory\ndescription: Personal context.\n---\n\n# Brain\n\nA long identifiable introduction explaining how durable information about the user is assessed and preserved.",
};
const meta = {
  type: "session_meta",
  payload: {
    id: "subject",
    agent_path: "/root/subject",
    source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } },
  },
};
const catalog = {
  type: "response_item",
  payload: {
    role: "developer",
    content: [
      {
        text: "## Skills\n- `r3` = `/installed`\n- agent-brain:brain-memory: Personal context. (file: r3/brain-memory/SKILL.md)",
      },
    ],
  },
};
const turn = { type: "turn_context", payload: { model: "gpt-6.1-sol" } };
const complete = {
  type: "event_msg",
  payload: { type: "task_complete", last_agent_message: "I used the skill." },
};
const read = {
  type: "response_item",
  payload: {
    type: "custom_tool_call",
    call_id: "c1",
    name: "exec",
    input:
      'await tools.exec_command({cmd:"cat /installed/brain-memory/SKILL.md"})',
  },
};
const output = {
  type: "response_item",
  payload: {
    type: "custom_tool_call_output",
    call_id: "c1",
    output: [
      { type: "input_text", text: JSON.stringify({ output: skill.content }) },
    ],
  },
};
const raw = (...items: unknown[]) =>
  items.map((e) => JSON.stringify(e)).join("\n");
const parse = (...items: unknown[]) =>
  parseNativeRollout(raw(meta, catalog, turn, ...items), skill, "gpt-6.1-sol");

test("native observation follows the selected entrypoint rather than a fixed skill name", () => {
  const rename = (s: string) =>
    s.replaceAll("brain-memory", "remember-user-context");
  const target = { path: rename(skill.path), content: rename(skill.content) };
  assert.equal(
    parseNativeRollout(
      rename(raw(meta, catalog, turn, read, output, complete)),
      target,
      "gpt-6.1-sol",
    ).loaded,
    true,
  );
  assert.throws(
    () =>
      parseNativeRollout(
        raw(meta, catalog, turn, read, output, complete),
        target,
        "gpt-6.1-sol",
      ),
    /metadata missing/,
  );
});

test("native audit checks actual reasoning effort, including missing runtime metadata", () => {
  const rollout = (effort?: string) =>
    raw(
      meta,
      catalog,
      { ...turn, payload: { ...turn.payload, effort } },
      complete,
    );
  assert.equal(
    parseNativeRollout(rollout("high"), skill, "gpt-6.1-sol", "high")
      .reasoningEffort,
    "high",
  );
  for (const effort of ["low", undefined])
    assert.throws(
      () => parseNativeRollout(rollout(effort), skill, "gpt-6.1-sol", "high"),
      /reasoning effort mismatch/,
    );
  // Legacy observations must still replay without gaining a new field.
  assert.equal(
    "reasoningEffort" in parseNativeRollout(rollout(), skill, "gpt-6.1-sol"),
    false,
  );
});

test("native activation requires returned skill content, not self-report, an attempted read or a different call's output", () => {
  assert.equal(parse(complete).loaded, false);
  assert.equal(parse(read, complete).loaded, false);
  assert.equal(
    parse(
      read,
      { ...output, payload: { ...output.payload, call_id: "other" } },
      complete,
    ).loaded,
    false,
  );

  const observation = parse(read, output, complete);
  assert.equal(observation.loaded, true);
  assert.deepEqual(observation.loadEvidence, [
    { callId: "c1", callLine: 4, outputLine: 5 },
  ]);
  assert.equal(observation.completed, true);
  assert.equal(parse(read, output).completed, false);
});

test("native activation rejects another copy of the skill even when its body is identical", () => {
  for (const path of [
    "plugins/agent-brain/skills/brain-memory/SKILL.md",
    "/another/brain-memory/SKILL.md",
    "/another/installed/brain-memory/SKILL.md",
    "/installed/brain-memory/SKILL.md.backup",
  ]) {
    const otherRead = {
      ...read,
      payload: {
        ...read.payload,
        input: read.payload.input.replace(skill.path, path),
      },
    };
    assert.equal(parse(otherRead, output, complete).loaded, false, path);
  }
  assert.equal(parse(read, output, complete).loaded, true);
});

test("native audit refuses absent metadata, wrong versions/models, preloaded bodies and multi-turn subjects", () => {
  assert.throws(
    () => parseNativeRollout(raw(meta, turn, complete), skill, "gpt-6.1-sol"),
    /metadata missing/,
  );
  assert.throws(
    () =>
      parseNativeRollout(
        raw(meta, catalog, turn, complete),
        { ...skill, path: "/another/brain-memory/SKILL.md" },
        "gpt-6.1-sol",
      ),
    /Installed skill differs/,
  );
  assert.throws(
    () =>
      parseNativeRollout(
        raw(meta, catalog, turn, complete),
        skill,
        "different-model",
      ),
    /model mismatch/,
  );
  assert.throws(() => parse(turn, complete), /exactly one turn/);
  assert.throws(
    () =>
      parse(
        {
          type: "response_item",
          payload: { role: "developer", content: [{ text: skill.content }] },
        },
        complete,
      ),
    /already loaded/,
  );
});

test("dispatch audit binds the exact frozen task to a fresh subject with the requested model and parent", () => {
  const request = nativeCases[0].request;
  const args = {
    task_name: "subject",
    fork_turns: "none",
    model: "gpt-6.1-sol",
    message: request,
  };
  const dispatch = (overrides = {}) =>
    raw(
      { type: "session_meta", payload: { id: "parent" } },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({ ...args, ...overrides }),
        },
      },
    );
  assert(
    verifyDispatch(
      dispatch(),
      "/root/subject",
      request,
      "gpt-6.1-sol",
      "parent",
    ),
  );
  assert.equal(
    verifyDispatch(
      dispatch({ message: "gAAAAAEncryptedPayload123=" }),
      "/root/subject",
      request,
      "gpt-6.1-sol",
      "parent",
    ).promptVerification,
    "manual-encrypted",
  );
  assert.throws(
    () =>
      verifyDispatch(
        dispatch({ message: `${request} Use Brain.` }),
        "/root/subject",
        request,
        "gpt-6.1-sol",
        "parent",
      ),
    /verbatim/,
  );
  assert.throws(
    () =>
      verifyDispatch(
        dispatch({ fork_turns: "all" }),
        "/root/subject",
        request,
        "gpt-6.1-sol",
        "parent",
      ),
    /not be inherited/,
  );
  assert.throws(
    () =>
      verifyDispatch(
        dispatch(),
        "/root/subject",
        request,
        "gpt-6.1-sol",
        "other-parent",
      ),
    /different parent/,
  );
});

test("custom native cases retain explicit expectations and reject ambiguous trial identities", () => {
  validateNativeCases(nativeCases);
  validateNativeCases([{ ...nativeCases[0], category: "implicit" }]);
  validateNativeCases([{ ...nativeCases[0], category: "retrieval" }]);
  assert.throws(
    () => validateNativeCases([{ ...nativeCases[0], category: "unknown" }]),
    /category/,
  );
  assert.throws(() => validateNativeCases([]), /nonempty/);
  assert.throws(
    () => validateNativeCases([nativeCases[0], nativeCases[0]]),
    /duplicate/,
  );
  assert.throws(
    () => validateNativeCases([{ ...nativeCases[0], expected: "true" }]),
    /boolean/,
  );
  assert.throws(
    () => validateNativeCases([{ ...nativeCases[0], request: "" }]),
    /request/,
  );
});

test("native reports keep retrieval and proactive activation coverage separate", async (t) => {
  t.mock.method(console, "log", () => {});
  const dir = await mkdtemp(join(tmpdir(), "brain-activation-coverage-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const skillFile = join(dir, "SKILL.md");
  const casesFile = join(dir, "cases.json");
  const run = join(dir, "run");
  await writeFile(skillFile, skill.content);
  const cases = [
    nativeCases[0],
    nativeCases.find((c) => c.category === "retrieval"),
  ];
  await writeFile(casesFile, JSON.stringify(cases));
  await nativeCommand("native-prepare", {
    out: run,
    "skill-file": skillFile,
    "cases-file": casesFile,
    repeats: "2",
  });
  await nativeCommand("native-report", { run });
  const result = JSON.parse(await readFile(join(run, "results.json"), "utf8"));
  for (const category of ["retrieval", "proactive"]) {
    const summary = result.summaries.find(
      (entry: { category: string }) => entry.category === category,
    );
    assert.equal(summary.scheduled, 2);
    assert.equal(summary.pending, 2);
    assert.equal(summary.completed, 0);
    assert.equal(summary.FN, 0);
  }
});

test("observer repair corrects activation while retaining original evidence and other audit checks", async (t) => {
  t.mock.method(console, "log", () => {});
  const dir = await mkdtemp(join(tmpdir(), "brain-observer-repair-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const skillFile = join(dir, "SKILL.md");
  const run = join(dir, "run");
  const casesFile = join(dir, "cases.json");
  const scenario = nativeCases.find((c) => c.category === "retrieval");
  assert(scenario);
  await writeFile(skillFile, skill.content);
  await writeFile(casesFile, JSON.stringify([scenario]));
  await nativeCommand("native-prepare", {
    out: run,
    "skill-file": skillFile,
    "cases-file": casesFile,
    repeats: "1",
  });
  const hash = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const manifestFile = join(run, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const trialId = manifest.trials[0].id;
  const catalogAtPath = JSON.parse(
    JSON.stringify(catalog).replace("r3/brain-memory/SKILL.md", skillFile),
  );
  const trace = raw(meta, catalogAtPath, turn, read, output, complete);
  const observed = parseNativeRollout(
    trace,
    { path: skillFile, content: skill.content },
    "gpt-6.1-sol",
  );
  const dispatch = raw(
    { type: "session_meta", payload: { id: "parent" } },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        arguments: JSON.stringify({
          task_name: "subject",
          fork_turns: "none",
          model: "gpt-6.1-sol",
          message: scenario.request,
        }),
      },
    },
  );
  // Simulate a historical observation that credited a different installed copy.
  const original = {
    ...observed,
    loaded: true,
    loadEvidence: [{ callId: "c1", callLine: 4, outputLine: 5 }],
    trialId,
    rolloutHash: hash(trace),
    dispatchHash: hash(dispatch),
    promptVerification: "exact",
    review: { proposedMemory: false, evidence: "No proposal", noWrites: true },
  };
  const observationFile = join(run, `${trialId}.json`);
  const originalBytes = JSON.stringify(original);
  await writeFile(observationFile, originalBytes);
  await writeFile(join(run, `${trialId}.rollout.jsonl`), trace);
  await writeFile(join(run, `${trialId}.dispatch.jsonl`), dispatch);
  const legacySource = "Historical observer fixture";
  manifest.harnessHash = hash(legacySource);
  await writeFile(manifestFile, JSON.stringify(manifest));
  await writeFile(join(run, "harness-source.ts"), legacySource);
  await assert.rejects(nativeCommand("native-report", { run }), /ENOENT/);
  await nativeCommand("native-repair-observer", {
    run,
    reason: "Bind activation to the frozen installed entrypoint",
  });
  await nativeCommand("native-report", { run });
  const result = JSON.parse(await readFile(join(run, "results.json"), "utf8"));
  assert.equal(result.rows[0].outcome, "FN");
  assert.equal(result.observerRepair.changes.length, 1);
  assert.equal(result.observerRepair.changes[0].originalLoaded, true);
  assert.equal(result.observerRepair.changes[0].correctedLoaded, false);
  assert.equal(await readFile(observationFile, "utf8"), originalBytes);
  await writeFile(
    observationFile,
    JSON.stringify({ ...original, toolCalls: original.toolCalls + 1 }),
  );
  await assert.rejects(
    nativeCommand("native-report", { run }),
    /Observation mismatch: toolCalls/,
  );
});
