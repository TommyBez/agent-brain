import { unstable_rethrow } from "next/navigation";
import {
  authErrorResponse,
  getPrincipal,
  requireScope,
} from "@/lib/auth-principal";
import { exportBrain } from "@/lib/operations";

export async function GET(request: Request) {
  try {
    const principal = await getPrincipal(request);
    requireScope(principal, "brain:maintain");
    return Response.json(await exportBrain(principal.ownerId), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": 'attachment; filename="brain.json"',
      },
    });
  } catch (error) {
    unstable_rethrow(error);
    return authErrorResponse(error);
  }
}
