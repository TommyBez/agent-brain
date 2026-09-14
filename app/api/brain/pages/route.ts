import { listPages, write } from "@/lib/brain/service";
import { body, failure, json, owner } from "../shared";

export async function GET(request: Request) {
  try {
    const ownerId = await owner(request);
    const params = new URL(request.url).searchParams;
    const data = await listPages(ownerId, {
      query: params.get("q") || undefined,
      type: params.get("type") || undefined,
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
    const ownerId = await owner(request, "brain:write");
    const input = await body(request);
    if (input.id)
      return json(
        { error: "Use the page endpoint to update an existing page." },
        400,
      );
    return json(
      { page: await write(ownerId, { ...input, source: "workspace" }) },
      201,
    );
  } catch (error) {
    return failure(error);
  }
}
