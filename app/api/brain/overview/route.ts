import { getStats, listActivity } from "@/lib/brain/service";
import { failure, json, owner } from "../shared";

export async function GET(request: Request) {
  try {
    const ownerId = await owner(request);
    const [stats, activity] = await Promise.all([
      getStats(ownerId),
      listActivity(ownerId, { limit: 50 }),
    ]);
    return json({ stats, activity });
  } catch (error) {
    return failure(error);
  }
}
