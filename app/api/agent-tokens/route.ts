import { unstable_rethrow } from "next/navigation";
import {
  createAgentToken,
  listAgentTokens,
  revokeAgentToken,
} from "@/lib/agent-tokens";
import {
  authErrorResponse,
  requireSessionPrincipal,
} from "@/lib/auth-principal";

export async function GET(request: Request) {
  try {
    const principal = await requireSessionPrincipal(request);
    return Response.json(
      { tokens: await listAgentTokens(principal.ownerId) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    unstable_rethrow(error);
    return authErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const principal = await requireSessionPrincipal(request);
    const result = await createAgentToken(
      principal.ownerId,
      await request.json(),
    );
    return Response.json(result, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof SyntaxError)
      return Response.json({ error: "Invalid JSON." }, { status: 400 });
    return authErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const principal = await requireSessionPrincipal(request);
    const result = await revokeAgentToken(
      principal.ownerId,
      await request.json(),
    );
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof SyntaxError)
      return Response.json({ error: "Invalid JSON." }, { status: 400 });
    return authErrorResponse(error);
  }
}
