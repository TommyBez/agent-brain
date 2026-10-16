import assert from "node:assert/strict";
import { z } from "zod";
import { fingerprint } from "../../lib/canonical-json";
import {
  BASELINE_PROMPTS,
  PROMPT_TASKS,
} from "../../lib/maintenance/consolidator/prompts";
import { requestFor, TASKS } from "./tasks";
import { type Example, exampleSchema, type Splits } from "./types";

export function validateDataset(input: unknown): Example[] {
  const examples = exampleSchema.array().min(1).parse(input);
  const ids = new Set<string>();
  for (const example of examples) {
    assert(!ids.has(example.id), `Duplicate example ID: ${example.id}`);
    ids.add(example.id);
    const rawState = example.state as Record<string, unknown>;
    const unitTask =
      example.task.startsWith("localize_") ||
      example.task.startsWith("partner_");
    const verification = example.task === "verification";
    const sourcePages =
      example.task === "relation"
        ? [rawState.source, rawState.target]
        : verification
          ? rawState.originalPages
          : rawState.pages;
    const state = z
      .object({
        pages: z
          .array(
            z
              .object({
                id: z.string().min(1),
                markdown:
                  unitTask || verification ? z.string().optional() : z.string(),
                links: z.array(z.unknown()),
              })
              .passthrough(),
          )
          .min(1),
        target: z
          .array(
            z
              .object({
                pageId: z.string(),
                text: z.string(),
                start: z.number().int().nonnegative(),
                end: z.number().int().nonnegative(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough()
      .parse({
        ...rawState,
        pages: sourcePages,
        ...(example.task === "relation" ? { target: undefined } : {}),
      });
    assert(!example.pair || state.pages.length >= 2, "Pair requires two pages");
    if (
      [
        "actionable",
        "resolution",
        "destination",
        "removable",
        "counterpart_duplicate",
        "counterpart_conflict",
      ].includes(example.task)
    ) {
      assert.equal(
        state.target?.length,
        example.task === "removable" ? 1 : 2,
        "Preparation requires two target passages",
      );
      for (const target of state.target ?? []) {
        const page = state.pages.find((p) => p.id === target.pageId);
        assert(
          page &&
            page.markdown?.slice(target.start, target.end) === target.text,
          "Target span does not match source page",
        );
      }
    }
    if (unitTask || verification) {
      const units = z
        .array(
          z
            .object({ id: z.string(), pageId: z.string(), text: z.string() })
            .passthrough(),
        )
        .min(1)
        .parse(verification ? rawState.originalUnits : rawState.units);
      assert(
        units.every((u) => state.pages.some((p) => p.id === u.pageId)),
        "Unit page missing",
      );
      if (example.task.startsWith("localize_"))
        assert(
          units[example.context?.unitIndex ?? -1],
          "Invalid localization index",
        );
      if (example.task.startsWith("partner_")) {
        assert(
          units.some((u) => u.id === example.context?.anchorId),
          "Anchor missing",
        );
        assert(
          example.context?.optionIds?.every(
            (id) =>
              id !== example.context?.anchorId &&
              units.some((u) => u.id === id),
          ),
          "Partner missing",
        );
      }
    }
    assert(
      TASKS[example.task].labels.includes(example.label.value),
      `Invalid label: ${example.id}`,
    );
    assert(
      !(
        example.label.method === "llm" || example.label.method === "consensus"
      ) || example.label.models.length > 0,
      "Judge identity is required",
    );
    assert(
      example.label.method !== "consensus" || example.label.agreement !== null,
      "Consensus agreement is required",
    );
    requestFor(example, BASELINE_PROMPTS[example.task]);
  }
  return examples;
}

export function eligible(example: Example) {
  return (
    example.label.status !== "uncertain" &&
    (example.label.confidence === null || example.label.confidence >= 0.8) &&
    (example.label.agreement === null || example.label.agreement >= 0.8)
  );
}

function contents(example: Example): string {
  const state = example.state as {
    pages?: { markdown?: string }[];
    units?: { text: string }[];
    originalUnits?: { text: string }[];
    source?: { markdown: string };
    target?: { markdown: string };
  };
  const texts =
    state.originalUnits?.map((u) => u.text) ??
    state.units?.map((u) => u.text) ??
    (example.task === "relation"
      ? [state.source?.markdown ?? "", state.target?.markdown ?? ""]
      : (state.pages ?? []).map((p) => p.markdown ?? ""));
  return texts.join("\n").toLowerCase().replace(/\s+/g, " ").trim();
}
function shingles(text: string) {
  const tokens = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(
    tokens.slice(2).map((_, index) => tokens.slice(index, index + 3).join(" ")),
  );
}

/** Source groups plus exact/near-duplicate components; no variant crosses a split. */
export function splitDataset(examples: Example[], seed: number): Splits {
  const parents = new Map(examples.map((e) => [e.group, e.group]));
  const root = (group: string): string =>
    parents.get(group) === group ? group : root(parents.get(group) as string);
  const join = (a: string, b: string) => {
    parents.set(root(b), root(a));
  };
  // Repeated checks of the same source do not add evidence for grouping.
  const sources = [
    ...new Map(
      examples.map((e) => {
        const text = contents(e);
        return [JSON.stringify([e.group, text]), { group: e.group, text }];
      }),
    ).values(),
  ];
  const texts = sources.map((e) => e.text);
  const grams = texts.map(shingles);
  for (let i = 0; i < sources.length; i++)
    for (let j = 0; j < i; j++) {
      if (root(sources[i].group) === root(sources[j].group)) continue;
      const a = grams[i];
      const b = grams[j];
      const overlap = [...a].filter((t) => b.has(t)).length;
      const similarity = overlap / Math.max(1, a.size + b.size - overlap);
      if (texts[i] === texts[j] || similarity >= 0.85)
        join(sources[i].group, sources[j].group);
    }
  const components = new Map<string, Example[]>();
  for (const e of examples) {
    const key = root(e.group);
    components.set(key, [...(components.get(key) ?? []), e]);
  }
  const strata = new Map<string, string[]>();
  for (const [group, rows] of components) {
    const stratum = [...new Set(rows.map((e) => e.language))].sort().join("+");
    strata.set(stratum, [...(strata.get(stratum) ?? []), group]);
  }
  const splits: Splits = { train: [], validation: [], test: [] };
  for (const groups of strata.values()) {
    assert(
      groups.length >= 5,
      "At least five independent source groups per language are required",
    );
    groups.sort((a, b) =>
      fingerprint([seed, a]).localeCompare(fingerprint([seed, b])),
    );
    const testCount = Math.max(1, Math.round(groups.length * 0.2));
    const validationCount = Math.max(1, Math.round(groups.length * 0.2));
    groups.forEach((group, index) => {
      const split =
        index < testCount
          ? "test"
          : index < testCount + validationCount
            ? "validation"
            : "train";
      splits[split].push(...(components.get(group) ?? []).map((e) => e.id));
    });
  }
  for (const ids of Object.values(splits)) ids.sort();
  validateSplits(examples, splits);
  return splits;
}

export function validateSplits(examples: Example[], splits: Splits) {
  const used = new Set<string>();
  const owners = new Map<string, string>();
  const byId = new Map(examples.map((e) => [e.id, e]));
  for (const [split, ids] of Object.entries(splits))
    for (const id of ids) {
      const e = byId.get(id);
      assert(e, "Unknown split ID");
      assert(!used.has(id), "Overlapping split ID");
      used.add(id);
      assert(
        !owners.has(e.group) || owners.get(e.group) === split,
        "Source leaked across splits",
      );
      owners.set(e.group, split);
    }
  assert.equal(
    used.size,
    examples.length,
    "Split must cover every example, including excluded labels",
  );
  for (const task of PROMPT_TASKS.filter((t) =>
    examples.some((e) => e.task === t),
  ))
    for (const [split, ids] of Object.entries(splits)) {
      const selected = examples.filter(
        (e) => ids.includes(e.id) && e.task === task && eligible(e),
      );
      for (const label of TASKS[task].labels)
        assert(
          selected.some((e) => e.label.value === label),
          `Missing ${task}/${label} in ${split}`,
        );
      for (const language of new Set(
        examples.filter((e) => e.task === task).map((e) => e.language),
      ))
        assert(
          selected.some((e) => e.language === language),
          `Missing ${language} in ${split}/${task}`,
        );
    }
}

export function supervisionSummary(examples: Example[]) {
  const counts = (key: (e: Example) => string) =>
    Object.fromEntries(
      [...new Set(examples.map(key))]
        .sort()
        .map((value) => [
          value,
          examples.filter((e) => key(e) === value).length,
        ]),
    );
  return {
    total: examples.length,
    excluded: examples.filter((e) => !eligible(e)).length,
    origins: counts((e) => e.origin),
    methods: counts((e) => e.label.method),
    statuses: counts((e) => e.label.status),
    languages: counts((e) => e.language),
    tasks: counts((e) => e.task),
    meanAgreement: examples.some((e) => e.label.agreement !== null)
      ? examples.reduce((sum, e) => sum + (e.label.agreement ?? 0), 0) /
        examples.filter((e) => e.label.agreement !== null).length
      : null,
  };
}
