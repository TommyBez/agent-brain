import { getGraph } from "@/lib/brain/service";
import { failure, json, owner } from "../shared";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    return json(
      await getGraph(await owner(request), {
        limit: Number(params.get("limit") || 60),
        offset: Number(params.get("offset") || 0),
        type: params.get("type") || undefined,
      }),
    );
  } catch (error) {
    return failure(error);
  }
}
