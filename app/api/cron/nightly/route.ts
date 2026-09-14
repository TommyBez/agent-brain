import { getPool } from "@/lib/db";
import { enqueueNightly, isCronRequest } from "@/lib/operations";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!isCronRequest(request))
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { rows } = await getPool().query(
    'SELECT id FROM "user" WHERE lower(email) = lower($1)',
    [process.env.BRAIN_OWNER_EMAIL],
  );
  if (!rows[0])
    return Response.json(
      { error: "Owner account has not been bootstrapped." },
      { status: 503 },
    );
  const queued = await enqueueNightly(rows[0].id);
  return Response.json({ queued, modelCalls: 0 });
}
