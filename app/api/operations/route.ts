import {
  AuthError,
  authErrorResponse,
  getPrincipal,
  requireScope,
  requireSessionPrincipal,
} from "@/lib/auth-principal";
import { startNightlyMaintenance } from "@/lib/maintenance/start";
import { operationsStatus } from "@/lib/operations";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const principal = await getPrincipal(request);
    requireScope(principal, "brain:read");
    return Response.json(await operationsStatus(principal.ownerId), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const principal = await requireSessionPrincipal(request);
    const run = await startNightlyMaintenance(principal.ownerId);
    return Response.json(run, {
      status: run.completed ? 200 : 202,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof AuthError) return authErrorResponse(error);
    console.error(
      "Could not start maintenance",
      error instanceof Error ? error.name : "unknown error",
    );
    return Response.json(
      { error: "Unable to start maintenance. Check Operations and try again." },
      { status: 503 },
    );
  }
}
