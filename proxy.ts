import { type NextRequest, NextResponse } from "next/server";
import { safeReturnTo, WORKSPACE_PATH_HEADER } from "@/lib/auth-navigation";

export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  // Always overwrite client input. The DAL remains the authentication boundary.
  headers.set(
    WORKSPACE_PATH_HEADER,
    safeReturnTo(`${request.nextUrl.pathname}${request.nextUrl.search}`),
  );
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: [
    "/",
    "/people",
    "/clients",
    "/projects",
    "/articles",
    "/decisions",
    "/notes",
    "/pages/:path*",
    "/graph",
    "/activity",
    "/agents",
    "/operations",
  ],
};
