import { allowedEmails } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { startNightlyMaintenance } from "@/lib/maintenance/start";
import { isCronRequest } from "@/lib/operations";

export const maxDuration = 60;

export async function GET(request: Request) {
  if (!isCronRequest(request))
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const emails = allowedEmails();
  const { rows } = await getPool().query<{ id: string }>(
    'SELECT id FROM "user" WHERE lower(email) = ANY($1::text[])',
    [emails],
  );
  if (!rows.length)
    return Response.json(
      { error: "No allowlisted account has been bootstrapped." },
      { status: 503 },
    );
  const runs = await Promise.all(
    rows.map(async (row) => ({
      ownerId: row.id,
      ...(await startNightlyMaintenance(row.id, "scheduled")),
    })),
  );
  return Response.json(
    { runs },
    {
      status: runs.every((run) => run.completed) ? 200 : 202,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
