import { getAuth, isAuthConfigured } from "@/lib/auth";
import { agentCorsPreflight, withAgentCors } from "@/lib/mcp/cors";

export async function GET(request: Request) {
  return withAgentCors(request, () => {
    if (!isAuthConfigured())
      return Response.json(
        { error: "Authentication has not been configured." },
        { status: 503 },
      );
    return getAuth().handler(request);
  });
}

export function OPTIONS(request: Request) {
  return agentCorsPreflight(request, ["GET", "HEAD"], ["Accept"]);
}
