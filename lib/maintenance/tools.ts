import { z } from "zod";
import * as schemas from "@/lib/brain/schemas";
import * as brain from "@/lib/brain/service";
import { BrainError } from "@/lib/brain/types";
import type {
  ConsolidationToolCall,
  ConsolidationToolResult,
} from "./consolidation";

const toolSchemas = {
  search: schemas.searchSchema,
  read: schemas.readSchema,
  write: schemas.writeSchema,
  append: schemas.appendSchema,
  resolve: schemas.resolveSchema,
  related: schemas.relatedSchema,
  context: schemas.contextSchema,
  gap_analysis: z.object({}).strict(),
  list_pages: schemas.listPagesSchema,
};
export function consolidationTools() {
  return Object.entries(toolSchemas).map(([name, schema]) => ({
    name,
    inputSchema: z.toJSONSchema(schema, { io: "input" }),
  }));
}
export type ReadReceipt = { id: string; version: number };
export type ToolExecution = ConsolidationToolResult & {
  read?: { refs: string[]; receipt: ReadReceipt };
};

/** Shares the MCP primitives, with an internal retry key and enforced read-before-write. */
export async function executeConsolidationTool(
  ownerId: string,
  call: ConsolidationToolCall,
  operationKey: string,
  reads: Record<string, ReadReceipt>,
  canWrite: boolean,
): Promise<ToolExecution> {
  const name = call.function.name;
  if (!Object.hasOwn(toolSchemas, name))
    return {
      toolCallId: call.id,
      result: { error: "Tool not allowed for consolidation." },
    };
  let input: unknown;
  try {
    input = JSON.parse(call.function.arguments);
  } catch {
    return {
      toolCallId: call.id,
      result: { error: "Tool arguments must be valid JSON." },
    };
  }
  try {
    let result: unknown;
    if (name === "write" || name === "append") {
      if (!canWrite)
        return {
          toolCallId: call.id,
          result: { error: "Write budget reached. Finish with a report." },
        };
      const args = z.record(z.string(), z.unknown()).parse(input);
      const data =
        name === "write"
          ? schemas.writeSchema.parse({
              ...args,
              source: "nightly-consolidation",
            })
          : schemas.appendSchema.parse({
              ...args,
              source: "nightly-consolidation",
            });
      const ref = "ref" in data ? data.ref : data.id;
      if (ref && reads[ref]?.version !== data.expectedVersion)
        return {
          toolCallId: call.id,
          result: {
            error:
              "Read the current full page before changing it, then use its version.",
          },
        };
      result =
        name === "write"
          ? await brain.write(ownerId, data, { operationKey })
          : await brain.append(ownerId, data, { operationKey });
      return { toolCallId: call.id, result, writeSucceeded: true };
    }
    switch (name) {
      case "read": {
        const args = schemas.readSchema.parse(input);
        const page = await brain.read(ownerId, args);
        return {
          toolCallId: call.id,
          result: page,
          read: {
            refs: [args.ref, page.id, page.slug],
            receipt: { id: page.id, version: page.version },
          },
        };
      }
      case "search":
        result = await brain.search(ownerId, input);
        break;
      case "resolve":
        result = await brain.resolve(ownerId, input);
        break;
      case "related":
        result = await brain.related(ownerId, input);
        break;
      case "context":
        result = await brain.context(ownerId, input);
        break;
      case "gap_analysis":
        toolSchemas.gap_analysis.parse(input);
        result = await brain.gapAnalysis(ownerId);
        break;
      case "list_pages":
        result = await brain.listPages(ownerId, input);
        break;
    }
    return { toolCallId: call.id, result };
  } catch (error) {
    // Expected tool errors go back to the agent; infrastructure errors trigger step retry.
    if (error instanceof BrainError)
      return {
        toolCallId: call.id,
        result: { error: error.code, message: error.message },
      };
    if (error instanceof z.ZodError)
      return {
        toolCallId: call.id,
        result: {
          error: "Invalid tool arguments.",
          issues: error.issues.map(({ path, message }) => ({ path, message })),
        },
      };
    throw new Error("Consolidation tool could not access the database.");
  }
}
