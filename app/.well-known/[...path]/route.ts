import { getAuth, isAuthConfigured } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!isAuthConfigured())
    return Response.json(
      { error: "Authentication has not been configured." },
      { status: 503 },
    );
  return getAuth().handler(request);
}
