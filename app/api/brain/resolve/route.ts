import { resolve } from "@/lib/brain/service";
import { failure, json, owner } from "../shared";

export async function GET(request: Request) {
  try {
    const ownerId = await owner(request);
    const params = new URL(request.url).searchParams;
    return json(
      await resolve(ownerId, {
        name: params.get("name"),
        type: params.get("type") || undefined,
        limit: 5,
      }),
    );
  } catch (error) {
    return failure(error);
  }
}
