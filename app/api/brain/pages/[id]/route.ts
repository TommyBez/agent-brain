import { body, failure, json, owner } from "@/app/api/shared";
import { listRevisionSummaries, read, write } from "@/lib/brain/service";
import { revalidateWorkspaceCache } from "@/lib/workspace/cache";

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const ownerId = await owner(request);
    const { id } = await context.params;
    const [page, revisions] = await Promise.all([
      read(ownerId, { ref: id }),
      listRevisionSummaries(ownerId, { ref: id, limit: 50 }),
    ]);
    return json({ page, revisions });
  } catch (error) {
    return failure(error);
  }
}
export async function PATCH(request: Request, context: Context) {
  try {
    const ownerId = await owner(request, "brain:write");
    const { id } = await context.params;
    const input = await body(request);
    const page = await write(ownerId, { ...input, id, source: "workspace" });
    revalidateWorkspaceCache(ownerId);
    return json({ page });
  } catch (error) {
    return failure(error);
  }
}
