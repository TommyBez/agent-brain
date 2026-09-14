import { listRevisions, read, write } from "@/lib/brain/service";
import { body, failure, json, owner } from "../../shared";

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const ownerId = await owner(request);
    const { id } = await context.params;
    const [page, revisions] = await Promise.all([
      read(ownerId, { ref: id }),
      listRevisions(ownerId, { ref: id, limit: 50 }),
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
    return json({
      page: await write(ownerId, { ...input, id, source: "workspace" }),
    });
  } catch (error) {
    return failure(error);
  }
}
