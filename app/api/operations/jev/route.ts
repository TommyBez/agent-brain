import { unstable_rethrow } from "next/navigation";
import {
  AuthError,
  authErrorResponse,
  requireSessionPrincipal,
} from "@/lib/auth-principal";
import {
  checkJevRuntime,
  jevRuntimeProfile,
} from "@/lib/maintenance/consolidator/runtime-diagnostics";
import { isCronRequest } from "@/lib/operations";

export const maxDuration = 60;

async function authorize(request: Request) {
  if (!isCronRequest(request)) await requireSessionPrincipal(request);
}

const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  try {
    await authorize(request);
    return Response.json(jevRuntimeProfile(), { headers });
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof AuthError) return authErrorResponse(error);
    return Response.json(
      { error: "Configurazione Jev non disponibile." },
      { status: 503, headers },
    );
  }
}

export async function POST(request: Request) {
  try {
    await authorize(request);
    return Response.json(await checkJevRuntime(), { headers });
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof AuthError) return authErrorResponse(error);
    return Response.json(
      { error: "Verifica Jev non completata. Riprova." },
      { status: 503, headers },
    );
  }
}
