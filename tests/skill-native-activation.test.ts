import assert from "node:assert/strict";
import test from "node:test";
import {
  nativeCases,
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
