import { z } from "zod";
import { fingerprint } from "../../canonical-json";
import { sanitizeTaskLine } from "../../tasks/sanitize";
import { TASK_LIMITS } from "../../tasks/types";
import { EDITOR_MODEL } from "../consolidator/budget";
import { EditorResponseError } from "../consolidator/diagnostics";
import { type GatewayCall, gatewayRequest } from "../gateway";
import { TASK_KEEPER_LIMITS } from "./policy";
import { EXTRACTION_INSTRUCTIONS, TASK_KEEPER_POLICY } from "./prompts";
import type { KeeperSnapshot } from "./snapshot";

// Step 3: the consolidator's DeepSeek editor pattern (strict JSON schema,
// temperature 0). The model names passages by id; the excerpt is cut from the
// snapshot by code. Model output is untrusted: ids, dates and projects are
// validated against the snapshot, and anything unknown is dropped.

export interface ExtractedItem {
  /** Unit indexes into snapshot.units, all among the localized candidates. */
  passages: number[];
  title: string;
  actorNames: string[];
  dueText: string | null;
  dueDate: string | null;
  projectId: string | null;
}

const modelItemSchema = z.strictObject({
  passageIds: z.array(z.string()),
  title: z.string(),
  actorNames: z.array(z.string()),
  dueText: z.string().nullable(),
  dueDate: z.string().nullable(),
  projectRef: z.string().nullable(),
});
const modelOutputSchema = z.strictObject({ items: z.array(modelItemSchema) });
type ModelOutput = z.output<typeof modelOutputSchema>;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function validCalendarDate(value: string | null): string | null {
  if (!value) return null;
  const match = ISO_DATE.exec(value.trim());
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d &&
    y >= 2000 &&
    y <= 2100
    ? value.trim()
    : null;
}

function line(value: string, max: number): string {
  const clean = sanitizeTaskLine(value);
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** Project candidates: the page itself when it is a project, then linked projects. */
export function projectCandidates(snapshot: KeeperSnapshot) {
  const projects = snapshot.linked.filter((page) => page.type === "project");
  if (snapshot.page.type === "project")
    projects.unshift({
      id: snapshot.page.id,
      slug: snapshot.page.slug,
      title: snapshot.page.title,
      type: "project",
      aliases: snapshot.page.aliases,
    });
  return projects.slice(0, 20);
}

/** The model's input: short aliases for passages (u<n>) and projects (j<n>). */
export function extractionContext(
  snapshot: KeeperSnapshot,
  candidates: number[],
) {
  const candidateSet = new Set(candidates);
  const all = snapshot.units.map((unit, index) => ({ unit, index }));
  const size = all.reduce((total, { unit }) => total + unit.text.length, 0);
  const included =
    size <= TASK_KEEPER_LIMITS.extractionCharacters
      ? all.filter(({ unit }) => unit.text.trim())
      : all.filter(
          ({ index }) =>
            candidateSet.has(index) ||
            candidateSet.has(index - 1) ||
            candidateSet.has(index + 1),
        );
  const projects = projectCandidates(snapshot);
  return {
    content: {
      page: {
        title: snapshot.page.title,
        type: snapshot.page.type,
        summary: snapshot.page.summary,
        tags: snapshot.page.tags,
      },
      units: included.map(({ unit, index }) => ({
        id: `u${index}`,
        headings: unit.headings,
        text: unit.text,
      })),
      candidatePassageIds: [...candidateSet]
        .sort((a, b) => a - b)
        .map((index) => `u${index}`),
      projects: projects.map((project, index) => ({
        id: `j${index}`,
        title: project.title,
      })),
    },
    projects,
    candidateSet,
  };
}

export function extractionRequestBody(
  content: ReturnType<typeof extractionContext>["content"],
) {
  return {
    model: EDITOR_MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: EXTRACTION_INSTRUCTIONS },
      { role: "user", content: JSON.stringify(content) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "task_commitments",
        strict: true,
        schema: z.toJSONSchema(modelOutputSchema),
      },
    },
  };
}

/** Cache identity of one extraction: policy, model and the exact input. */
export function extractionKey(body: unknown): string {
  return fingerprint({ policy: TASK_KEEPER_POLICY.version, body });
}

/** Validates raw model output against the snapshot. Pure. */
export function materializeExtraction(
  snapshot: KeeperSnapshot,
  output: ModelOutput,
  context: Pick<
    ReturnType<typeof extractionContext>,
    "projects" | "candidateSet"
  >,
): ExtractedItem[] {
  const items: ExtractedItem[] = [];
  for (const raw of output.items) {
    if (items.length >= TASK_KEEPER_LIMITS.itemsPerPage) break;
    const passages = [
      ...new Set(
        raw.passageIds
          .map((id) => /^u(\d{1,6})$/.exec(id.trim())?.[1])
          .filter((index): index is string => index !== undefined)
          .map(Number)
          .filter(
            (index) =>
              context.candidateSet.has(index) &&
              snapshot.units[index] !== undefined,
          ),
      ),
    ].sort((a, b) => a - b);
    const title = line(raw.title, TASK_LIMITS.title);
    if (!passages.length || !title) continue;
    const actorNames: string[] = [];
    for (const name of raw.actorNames) {
      const clean = line(name, TASK_LIMITS.partyGroupLabel);
      if (
        clean &&
        actorNames.length < 5 &&
        !actorNames.some(
          (known) => known.toLocaleLowerCase() === clean.toLocaleLowerCase(),
        )
      )
        actorNames.push(clean);
    }
    const dueText = raw.dueText ? line(raw.dueText, TASK_LIMITS.dueText) : "";
    const project = raw.projectRef
      ? context.projects[
          Number(/^j(\d{1,3})$/.exec(raw.projectRef.trim())?.[1])
        ]
      : undefined;
    items.push({
      passages,
      title,
      actorNames,
      dueText: dueText || null,
      dueDate: validCalendarDate(raw.dueDate),
      projectId:
        project?.id ??
        (snapshot.page.type === "project" ? snapshot.page.id : null),
    });
  }
  return items;
}

type ChatResponse = {
  id?: string;
  choices?: {
    finish_reason?: string;
    message?: { content?: string; refusal?: string };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
};

/** Parses a chat completion like the consolidator's editor; nothing is written here. */
export function parseExtractionResponse(response: ChatResponse): ModelOutput {
  function responseError(reason: EditorResponseError["reason"]): never {
    throw new EditorResponseError(
      reason,
      {
        prompt_tokens: response.usage?.prompt_tokens,
        completion_tokens: response.usage?.completion_tokens,
        reasoning_tokens:
          response.usage?.completion_tokens_details?.reasoning_tokens,
      },
      response.id,
    );
  }
  if (response.choices?.length !== 1) responseError("invalid_choices");
  const choice = response.choices[0];
  if (choice.finish_reason === "length") responseError("truncated_output");
  if (choice.message?.refusal || choice.finish_reason === "content_filter")
    responseError("refused_output");
  if (choice.finish_reason !== "stop")
    responseError("unexpected_finish_reason");
  const content = choice.message?.content;
  if (typeof content !== "string") responseError("missing_content");
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    responseError("invalid_json");
  }
  const parsed = modelOutputSchema.safeParse(raw);
  if (!parsed.success) responseError("invalid_schema");
  return parsed.data;
}

/** One extraction call for a screened page's candidate passages. */
export async function extractCommitments(
  snapshot: KeeperSnapshot,
  candidates: number[],
  send: GatewayCall = gatewayRequest,
): Promise<ExtractedItem[]> {
  const context = extractionContext(snapshot, candidates);
  const response = await send<ChatResponse>(
    "chat/completions",
    extractionRequestBody(context.content),
  );
  return materializeExtraction(
    snapshot,
    parseExtractionResponse(response),
    context,
  );
}
