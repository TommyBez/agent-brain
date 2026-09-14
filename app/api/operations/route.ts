import {
  authErrorResponse,
  getPrincipal,
  requireScope,
} from "@/lib/auth-principal";
import { operationsStatus } from "@/lib/operations";

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
