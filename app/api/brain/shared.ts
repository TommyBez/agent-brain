import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";
import type { BrainScope } from "@/lib/auth";
import {
  AuthError,
  authErrorResponse,
  getPrincipal,
  requireScope,
} from "@/lib/auth-principal";
import { BrainError } from "@/lib/brain/types";

export async function owner(
  request: Request,
  scope: BrainScope = "brain:read",
) {
  const principal = await getPrincipal(request);
  requireScope(principal, scope);
  return principal.ownerId;
}
export function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
export function failure(error: unknown) {
  unstable_rethrow(error);
  if (error instanceof AuthError) return authErrorResponse(error);
  if (error instanceof BrainError)
    return json(
      { error: error.message, code: error.code, details: error.details },
      error.status,
    );
  if (error instanceof ZodError)
    return json(
      {
        error: error.issues
          .map(
            (issue) => `${issue.path.join(".") || "Request"}: ${issue.message}`,
          )
          .join("; "),
        code: "validation_error",
      },
      400,
    );
  if (error instanceof SyntaxError)
    return json({ error: "The request body must be valid JSON." }, 400);
  console.error(
    "Brain API request failed",
    error instanceof Error ? error.name : "unknown error",
  );
  return json(
    { error: "Your knowledge is temporarily unavailable. Please try again." },
    503,
  );
}
export async function body(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 400_000)
    throw new BrainError("request_too_large", "The page is too large.", 413);
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new BrainError("invalid_request", "Expected a JSON object.", 400);
  return data;
}
