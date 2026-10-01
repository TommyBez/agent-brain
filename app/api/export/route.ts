import { failure, owner } from "@/app/api/shared";
import { exportBrain } from "@/lib/operations";

export async function GET(request: Request) {
  try {
    const ownerId = await owner(request, "brain:maintain");
    return Response.json(await exportBrain(ownerId), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": 'attachment; filename="brain.json"',
      },
    });
  } catch (error) {
    return failure(error);
  }
}
