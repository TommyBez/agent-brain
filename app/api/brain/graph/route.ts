import { getGraph } from "@/lib/brain/service";
import { failure, json, owner } from "../shared";

export async function GET(request: Request) {
  try {
    return json(await getGraph(await owner(request), { limit: 60 }));
  } catch (error) {
    return failure(error);
  }
}
