import { z } from "zod";
import {
  authErrorResponse,
  getPrincipal,
  requireScope,
} from "@/lib/auth-principal";
import { BrainError } from "@/lib/brain/types";
import { claimJob, finishJob } from "@/lib/operations";

const inputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("claim"),
      kind: z.enum(["consolidation", "export"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("finish"),
      id: z.uuid(),
      leaseId: z.uuid(),
      status: z.enum(["succeeded", "failed"]),
      result: z.record(z.string(), z.unknown()).optional(),
      error: z.string().max(2000).optional(),
    })
    .strict(),
]);

export async function POST(request: Request) {
  try {
    const principal = await getPrincipal(request);
    requireScope(principal, "brain:maintain");
    const raw = await request.text();
    if (raw.length > 20_000)
      return Response.json({ error: "Request too large" }, { status: 413 });
    const input = inputSchema.parse(JSON.parse(raw));
    return Response.json(
      input.action === "claim"
        ? { job: await claimJob(principal.ownerId, input.kind) }
        : await finishJob(principal.ownerId, input),
    );
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return Response.json(
        { error: "Invalid worker request" },
        { status: 400 },
      );
    if (error instanceof BrainError)
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    return authErrorResponse(error);
  }
}
