import { failure, json, owner } from "@/app/api/shared";
import { readRevision } from "@/lib/brain/history";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; version: string }> },
) {
  try {
    const ownerId = await owner(request);
    const { id, version } = await context.params;
    return json({
      revision: await readRevision(ownerId, {
        ref: id,
        version: Number(version),
      }),
    });
  } catch (error) {
    return failure(error);
  }
}
