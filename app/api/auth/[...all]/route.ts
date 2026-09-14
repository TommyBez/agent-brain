import { getAuth, isAuthConfigured } from "@/lib/auth";

export const runtime = "nodejs";

async function handler(request: Request) {
  if (!isAuthConfigured())
    return Response.json(
      { error: "Authentication has not been configured." },
      { status: 503 },
    );
  return getAuth().handler(request);
}

export { handler as GET, handler as POST };
