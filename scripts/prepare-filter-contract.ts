import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { consolidationProposalSchema } from "../lib/maintenance/consolidation-proposals";
import {
  CONSOLIDATION_CRITERIA,
  CONSOLIDATION_QUESTIONS_V2,
} from "../lib/maintenance/consolidation-rubric";

const text = z.string().min(1);
const markdown = text.max(6_000);
const pageId = text.regex(/^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/);
const judgment = z.strictObject({
  verdict: z.enum(["pass", "fail"]),
  rationale: text,
});
const criteria = z.strictObject({
  supported_by_evidence: judgment.optional(),
  preserves_distinct_information: judgment.optional(),
  no_new_human_action: judgment.optional(),
  meaningful_improvement: judgment.optional(),
});
const sourceSchema = z.strictObject({
  pageId,
  version: z.literal(1),
  title: text,
  markdown,
});
const fixtureSchema = z.strictObject({
  version: z.literal(1),
  scope: z.literal("jev-kimi-only"),
  scenarios: z
    .array(
      z.strictObject({
        scenarioId: text.regex(/^C\d{2}$/),
        title: text,
        target: sourceSchema.extend({
          type: z.literal("project"),
          summary: z.string(),
        }),
        sources: z.array(sourceSchema),
        rules: z
          .array(
            z.strictObject({
              id: text,
              description: text,
              evidence: z.array(z.strictObject({ pageId, quote: text })).min(1),
            }),
          )
          .min(1),
        candidates: z
          .array(
            z.strictObject({
              designId: text,
              label: text,
              afterMarkdown: markdown,
              expectedDecision: z.enum(["accept", "reject"]),
              expectedCriteria: criteria,
              rationale: text,
              contrastWith: text.optional(),
              proof: z
                .array(
                  z.strictObject({
                    location: z.enum(["before", "after", "source"]),
                    pageId: pageId.optional(),
                    quote: text,
                  }),
                )
                .min(1),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});

type Fixture = z.infer<typeof fixtureSchema>;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const block = (value: string) => `\n\`\`\`markdown\n${value}\n\`\`\`\n`;

function requireCondition(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

function links(value: string): string[] {
  return [...value.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)]
    .map((match) => match[1].replace(/^<|>$/g, ""))
    .filter((href) => !/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(href));
}

/** Constructs fixed inputs and a separate reference; it never calls a model. */
export function buildFilterContract(value: unknown) {
  const fixture = fixtureSchema.parse(value);
  const scenarioIds = new Set<string>();
  const designIds = new Set<string>();
  const allInputs = new Set<string>();
  const targets = new Set<string>();
  const entries = fixture.scenarios.flatMap((scenario) => {
    const { target } = scenario;
    requireCondition(
      !scenarioIds.has(scenario.scenarioId) && !targets.has(target.pageId),
      `Duplicate scenario or target: ${scenario.scenarioId}`,
    );
    scenarioIds.add(scenario.scenarioId);
    targets.add(target.pageId);
    const sources = [
      {
        pageId: target.pageId,
        version: target.version,
        title: target.title,
        markdown: target.markdown,
      },
      ...scenario.sources,
    ];
    const pages = new Map(sources.map((source) => [source.pageId, source]));
    requireCondition(pages.size === sources.length, "Duplicate evidence page.");
    const ruleIds = new Set<string>();
    for (const rule of scenario.rules) {
      requireCondition(!ruleIds.has(rule.id), `Duplicate rule: ${rule.id}`);
      ruleIds.add(rule.id);
      for (const proof of rule.evidence)
        requireCondition(
          pages.get(proof.pageId)?.markdown.includes(proof.quote),
          `Rule evidence is not verbatim: ${scenario.scenarioId}/${rule.id}`,
        );
    }
    const citations = sources.map((source) => ({
      pageId: source.pageId,
      version: source.version,
      quote: source.markdown,
    }));
    const before = {
      title: target.title,
      type: target.type,
      summary: target.summary,
      markdown: target.markdown,
    };
    return scenario.candidates.map((candidate) => {
      requireCondition(
        !designIds.has(candidate.designId) &&
          candidate.designId.startsWith(`${scenario.scenarioId}-`),
        `Duplicate or inconsistent design ID: ${candidate.designId}`,
      );
      designIds.add(candidate.designId);
      requireCondition(
        candidate.afterMarkdown !== target.markdown,
        `Unchanged proposal: ${candidate.designId}`,
      );
      const labels = Object.values(candidate.expectedCriteria);
      requireCondition(
        candidate.expectedDecision === "accept"
          ? CONSOLIDATION_CRITERIA.every(
              (criterion) =>
                candidate.expectedCriteria[criterion]?.verdict === "pass",
            )
          : labels.some((label) => label.verdict === "fail"),
        `Expected decision lacks decisive criteria: ${candidate.designId}`,
      );
      if (candidate.contrastWith)
        requireCondition(
          candidate.contrastWith !== candidate.designId &&
            scenario.candidates.some(
              (other) => other.designId === candidate.contrastWith,
            ),
          `Unknown contrast proposal: ${candidate.designId}`,
        );
      for (const proof of candidate.proof) {
        const content =
          proof.location === "source"
            ? scenario.sources.find((source) => source.pageId === proof.pageId)
                ?.markdown
            : proof.location === "before"
              ? target.markdown
              : candidate.afterMarkdown;
        requireCondition(
          (proof.location === "source" ||
            !proof.pageId ||
            proof.pageId === target.pageId) &&
            content?.includes(proof.quote),
          `Candidate proof is not verbatim: ${candidate.designId}`,
        );
      }
      const oldLinks = new Set(links(target.markdown));
      for (const href of links(candidate.afterMarkdown))
        requireCondition(
          oldLinks.has(href) || pages.has(href.split(/[?#]/)[0]),
          `New unresolved link: ${candidate.designId}/${href}`,
        );
      const operation = consolidationProposalSchema.parse({
        operation: "consolidate_passage",
        pageId: target.pageId,
        expectedVersion: target.version,
        reason: "Consolidamento dei contenuti della pagina.",
        before: target.markdown,
        after: candidate.afterMarkdown,
        evidence: citations,
      });
      const input = {
        before,
        after: { ...before, markdown: candidate.afterMarkdown },
        evidence: { sources, citations },
        operation,
      };
      const inputHash = hash(JSON.stringify(input));
      requireCondition(
        !allInputs.has(inputHash),
        "Duplicate evaluation input.",
      );
      allInputs.add(inputHash);
      return { scenario, candidate, input, inputHash };
    });
  });
  entries.sort((a, b) =>
    hash(a.candidate.designId).localeCompare(hash(b.candidate.designId)),
  );
  const cases = entries.map((entry, index) => ({
    ...entry,
    caseId: `Q${String(index + 1).padStart(2, "0")}`,
  }));
  const inputs = {
    version: 1,
    scope: "jev-kimi-only",
    cases: cases.map(({ caseId, inputHash, input }) => ({
      caseId,
      inputHash,
      input,
    })),
  };
  const reference = {
    version: 1,
    scope: "jev-kimi-only",
    referenceOrigin: "fixed-contract-from-agreed-scenarios",
    missingCriterionPolicy: "not_scored",
    scenarioRules: fixture.scenarios.map(({ scenarioId, title, rules }) => ({
      scenarioId,
      title,
      rules,
    })),
    cases: cases.map(({ caseId, inputHash, scenario, candidate }) => ({
      caseId,
      inputHash,
      scenarioId: scenario.scenarioId,
      designId: candidate.designId,
      label: candidate.label,
      expectedDecision: candidate.expectedDecision,
      expectedCriteria: candidate.expectedCriteria,
      rationale: candidate.rationale,
      ...(candidate.contrastWith
        ? { contrastWith: candidate.contrastWith }
        : {}),
      proof: candidate.proof,
    })),
  };
  const manifestSummary = {
    scenarios: fixture.scenarios.length,
    proposals: cases.length,
    expectedAccept: cases.filter(
      ({ candidate }) => candidate.expectedDecision === "accept",
    ).length,
    expectedReject: cases.filter(
      ({ candidate }) => candidate.expectedDecision === "reject",
    ).length,
    explicitCriteria: Object.fromEntries(
      CONSOLIDATION_CRITERIA.map((criterion) => [
        criterion,
        cases.filter(({ candidate }) => candidate.expectedCriteria[criterion])
          .length,
      ]),
    ),
  };
  return {
    inputs,
    reference,
    manifestSummary,
    reviewMarkdown: renderReview(fixture, cases),
  };
}

function renderReview(
  fixture: Fixture,
  cases: Array<{
    caseId: string;
    candidate: Fixture["scenarios"][number]["candidates"][number];
  }>,
) {
  const lines = [
    "# Proposte fisse per il filtro Jev + Kimi",
    "",
    "Dataset costruito prima del test. DeepSeek non viene eseguito. Questa è la scheda di revisione: le risposte attese e le prove restano separate dagli input inviabili ai modelli. Non ci sono ancora punteggi o risultati.",
    "",
    "Un criterio assente dal riferimento significa `not_scored`, non pass e non uncertain. Per accettare una proposta sono documentati tutti e quattro i criteri; per respingerla basta la violazione decisiva indicata.",
  ];
  for (const scenario of fixture.scenarios) {
    lines.push(`\n## ${scenario.scenarioId} — ${scenario.title}`);
    lines.push(
      `\n### Prima: ${scenario.target.pageId}`,
      block(scenario.target.markdown),
    );
    for (const source of scenario.sources)
      lines.push(
        `\n### Fonte invariata: ${source.pageId}`,
        block(source.markdown),
      );
    lines.push("\n### Condizioni fissate");
    for (const rule of scenario.rules) {
      lines.push(`\n- **${rule.id}:** ${rule.description}`);
      for (const proof of rule.evidence)
        lines.push(
          `  - Evidenza in \`${proof.pageId}\`: ${JSON.stringify(proof.quote)}`,
        );
    }
    for (const candidate of scenario.candidates) {
      const entry = cases.find(
        (item) => item.candidate.designId === candidate.designId,
      );
      lines.push(
        `\n### ${entry?.caseId} / ${candidate.designId} — ${candidate.label}`,
      );
      lines.push(
        `\n**Esito atteso: ${candidate.expectedDecision === "accept" ? "accettare" : "respingere"}.** ${candidate.rationale}`,
      );
      if (candidate.contrastWith)
        lines.push(`\nConfronto controllato con: ${candidate.contrastWith}.`);
      lines.push(
        "\n**Dopo:**",
        block(candidate.afterMarkdown),
        "\n**Criteri esplicitamente valutabili:**",
      );
      for (const criterion of CONSOLIDATION_CRITERIA) {
        const judgment = candidate.expectedCriteria[criterion];
        if (judgment)
          lines.push(
            `\n- \`${criterion}\`: **${judgment.verdict}**. ${judgment.rationale}`,
          );
      }
      lines.push("\n**Passaggi verificabili:**");
      for (const proof of candidate.proof)
        lines.push(
          `\n- ${proof.location}${proof.pageId ? ` — ${proof.pageId}` : ""}: ${JSON.stringify(proof.quote)}`,
        );
    }
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const { values } = parseArgs({
    options: { output: { type: "string" }, fixture: { type: "string" } },
  });
  if (!values.output)
    throw new Error("Use --output <directory> [--fixture <file>]");
  const fixtureText = await readFile(
    resolve(
      values.fixture ?? "scripts/fixtures/consolidation-filter-contract.json",
    ),
    "utf8",
  );
  const built = buildFilterContract(JSON.parse(fixtureText));
  const counts = built.manifestSummary;
  requireCondition(
    counts.scenarios === 6 &&
      counts.proposals === 24 &&
      counts.expectedAccept === 8 &&
      counts.expectedReject === 16,
    "The benchmark contract requires 6 scenarios, 24 proposals, 8 accepted and 16 rejected references.",
  );
  const inputText = json(built.inputs);
  const referenceText = json(built.reference);
  const files = {
    "inputs.json": inputText,
    "reference.json": referenceText,
    "casi.md": built.reviewMarkdown,
    "manifest.json": json({
      version: 1,
      scope: "jev-kimi-only",
      status: "prepared-not-executed",
      referenceOrigin: "fixed-contract-from-agreed-scenarios",
      ...counts,
      fixtureHash: hash(fixtureText),
      rubricHash: hash(json(CONSOLIDATION_QUESTIONS_V2)),
      inputsHash: hash(inputText),
      referenceHash: hash(referenceText),
      reviewHash: hash(built.reviewMarkdown),
      inputHashMethod: "SHA256(JSON.stringify(input))",
      artifactHashMethod: "SHA256 of exact UTF-8 file bytes",
      missingCriterionPolicy: "not_scored",
    }),
  };
  const directory = resolve(values.output);
  const missing: string[] = [];
  // Verify every existing file before writing any missing artifact.
  for (const [name, content] of Object.entries(files)) {
    try {
      requireCondition(
        (await readFile(join(directory, name), "utf8")) === content,
        `Refusing to overwrite different artifact: ${name}`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(name);
    }
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of missing)
    await writeFile(join(directory, name), files[name as keyof typeof files], {
      flag: "wx",
      mode: 0o600,
    });
  console.log(
    JSON.stringify({ directory, ...counts, written: missing.length }),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Preparation failed.",
    );
    process.exitCode = 1;
  });
