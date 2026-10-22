import { body, failure, json, owner } from "@/app/api/shared";
import { getPrincipal, requireScope } from "@/lib/auth-principal";
import { listPages, write } from "@/lib/brain/service";
import { resolveActor } from "@/lib/tasks/actors";
import { revalidateWorkspaceCache } from "@/lib/workspace/cache";

export async function GET(request: Request) {
  try {
    const ownerId = await owner(request);
    const params = new URL(request.url).searchParams;
    const data = await listPages(ownerId, {
      query: params.get("q") || undefined,
      type: params.get("type") || undefined,
      sort: params.get("sort") || "updated",
      limit: Number(params.get("limit") || 50),
      offset: Number(params.get("offset") || 0),
    });
    return json(data);
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    const principal = await getPrincipal(request);
    requireScope(principal, "brain:write");
    const ownerId = principal.ownerId;
    const input = await body(request);
    if (input.id)
      return json(
        { error: "Use the page endpoint to update an existing page." },
        400,
      );
    // A browser session signs as the owner; a bearer credential as its agent.
    const actor = await resolveActor(ownerId, principal);
    const page = await write(
      ownerId,
      { ...input, source: "workspace" },
      { actorAgentId: actor.agentId },
    );
    revalidateWorkspaceCache(ownerId);
    return json({ page }, 201);
  } catch (error) {
    return failure(error);
  }
}
