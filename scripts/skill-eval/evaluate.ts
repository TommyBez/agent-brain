import { z } from "zod";
import type { Page, Trace } from "./brain";
import type { Scenario } from "./dataset";

export type Bundle = {
  files: Record<string, string>;
  instructions: string;
  catalog?: { name: string; description: string; path: string }[];
};
export type Session = {
  id: string;
  bundle: Bundle;
  initial: Page[];
  pages: Page[];
  trace: Trace[];
  status: "running" | "completed" | "error" | "limit";
  final: string;
  error?: string;
  maxCalls: number;
  mode: "loaded" | "discovery";
  model: string;
};
export const reviewSchema = z
  .object({
    reviewer: z.string().min(1),
    correctChoiceAndScope: z.boolean(),
    faithfulToSources: z.boolean(),
    preservesExistingKnowledge: z.boolean(),
    evidence: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type Review = z.infer<typeof reviewSchema>;

export function score(scenario: Scenario, session: Session, review?: Review) {
  const initialIds = new Set(session.initial.map((p) => p.id));
  const decisions = session.pages.filter((p) => p.type === "decision");
  const newDecisions = decisions.filter((p) => !initialIds.has(p.id));
  const mutations = session.trace.filter((t) => t.mutation && !t.error);
  const checks: Record<string, boolean> = {
    completed: session.status === "completed",
    newDecisionCount: newDecisions.length === scenario.expected.newDecisions,
    totalDecisionCount:
      decisions.length ===
      session.initial.filter((p) => p.type === "decision").length +
        scenario.expected.newDecisions,
    requestedUpdates: scenario.expected.updatedIds.every((id) =>
      mutations.some((t) => t.pageId === id),
    ),
    noUnauthorizedOrRedundantWrites:
      !scenario.expected.noMutations || mutations.length === 0,
    existingEntitiesPreserved: session.initial.every((p) =>
      session.pages.some((q) => q.id === p.id && q.type === p.type),
    ),
    requiredLinks: scenario.expected.links.every((link) =>
      session.pages.some(
        (p) =>
          (link.from === "new-decision"
            ? newDecisions.some((d) => d.id === p.id)
            : p.id === link.from) &&
          p.links.some(
            (e) => e.type === link.type && e.targetRef === link.targetId,
          ),
      ),
    ),
    metadataPreserved: session.initial.every((before) => {
      const after = session.pages.find((p) => p.id === before.id);
      return (
        after &&
        before.aliases.every((a) => after.aliases.includes(a)) &&
        before.tags.every((t) => after.tags.includes(t)) &&
        before.relationships.every((r) => after.relationships.includes(r)) &&
        before.links.every((link) =>
          after.links.some(
            (e) =>
              e.targetRef === link.targetRef &&
              e.type === link.type &&
              e.label === link.label,
          ),
        )
      );
    }),
    readBeforeUpdate: session.trace.every(
      (t, index) =>
        !t.mutation ||
        t.version === 1 ||
        session.trace
          .slice(0, index)
          .some(
            (r) =>
              r.tool === "read" &&
              !r.error &&
              r.pageId === t.pageId &&
              r.version === (t.version ?? 0) - 1,
          ),
    ),
    readBack: session.pages
      .filter((p) => mutations.some((t) => t.pageId === p.id))
      .every((p) => {
        const lastWrite = session.trace.findLastIndex(
          (t) => t.mutation && t.pageId === p.id,
        );
        return session.trace
          .slice(lastWrite + 1)
          .some(
            (t) =>
              t.tool === "read" &&
              !t.error &&
              t.pageId === p.id &&
              t.version === p.version,
          );
      }),
  };
  const structuralPass = Object.values(checks).every(Boolean);
  const semanticPass = review
    ? review.correctChoiceAndScope &&
      review.faithfulToSources &&
      review.preservesExistingKnowledge
    : null;
  return {
    checks,
    structuralPass,
    semanticPass,
    overallPass: semanticPass === null ? null : structuralPass && semanticPass,
    newDecisions: newDecisions.length,
    expectedNewDecisions: scenario.expected.newDecisions,
    extraDecisions: Math.max(
      0,
      newDecisions.length - scenario.expected.newDecisions,
    ),
    missingDecisions: Math.max(
      0,
      scenario.expected.newDecisions - newDecisions.length,
    ),
    toolErrors: session.trace.filter((t) => t.error).length,
    mutations: mutations.length,
    activated:
      session.mode === "loaded" ||
      session.trace.some(
        (t) =>
          t.tool === "read_skill" &&
          !t.error &&
          (t.input as { path?: string }).path === "SKILL.md",
      ),
  };
}

/** Only task and skill material go to the subject; no case ID, arm label or expected answer. */
export function subjectPrompt(
  request: string,
  bundle: Bundle,
  mode: Session["mode"],
  command: string,
) {
  const skill = bundle.files["SKILL.md"];
  const metadata = skill.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (!metadata) throw new Error("Skill frontmatter missing");
  return (
    `Complete the user's task below using the available local Brain tools. This is an isolated synthetic task. Do not access real Brain connectors, network services, other sessions, the repository, evaluation data, or parent folders. Do not edit session files directly. The only permitted state changes are through the command below. The tools do not connect to a real database.\n\n` +
    `You can call context, resolve, search, read, related, list_pages, write and append with their Brain inputs. Read a skill reference with read_skill {"path":"references/decisions.md"}, or the entrypoint with {"path":"SKILL.md"}. Each tool returns its result or a recoverable error.\n\n` +
    `Tool command: ${command} tool --name TOOL --input 'JSON_OBJECT'\nUse properly shell-quoted JSON, or write JSON to a temporary file and use --input-file PATH. Tool inputs may be batched sequentially with --batch-file PATH containing [{"tool":"read","input":{"ref":"..."}}]. Choose later actions from results, not guesses.\n` +
    `When done, record your final answer with: ${command} finish --text 'FINAL_ANSWER' (or --text-file PATH). If unable to finish, use finish --error 'REASON'. Do not claim success before tools confirm it.\n\n` +
    `Brain server instructions:\n${bundle.instructions}\n\n` +
    (mode === "loaded"
      ? `Use this skill:\n${skill}`
      : `Available skill (load with read_skill if relevant):\n${metadata}`) +
    `\n\nUser task:\n${request}\n`
  );
}
