import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getSession } from "@/lib/auth";
import { ConsentForm } from "./consent-form";
import "./consent.css";

async function AuthorizedConsent({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const session = await getSession(await headers());
  if (!session) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (typeof value === "string") params.set(key, value);
    redirect(`/sign-in?${params.toString()}`);
  }
  const clientId = typeof query.client_id === "string" ? query.client_id : "";
  const redirectUri =
    typeof query.redirect_uri === "string" ? query.redirect_uri : "";
  const scopes =
    typeof query.scope === "string"
      ? query.scope.split(" ").filter(Boolean)
      : [];
  let claims: string[] = [];
  if (typeof query.claims === "string") {
    try {
      const requested: unknown = JSON.parse(query.claims);
      if (requested && typeof requested === "object") {
        claims = [
          ...new Set(
            Object.values(requested).flatMap((value) =>
              value && typeof value === "object" && !Array.isArray(value)
                ? Object.keys(value)
                : [],
            ),
          ),
        ];
      }
    } catch {
      /* The authorization provider rejects malformed signed claims. */
    }
  }
  return (
    <>
      <p>
        Signed in as {session.user.email}. Review the permissions before
        connecting this agent to your private brain.
      </p>
      <ConsentForm
        clientId={clientId}
        scopes={scopes}
        claims={claims}
        redirectUri={redirectUri}
      />
    </>
  );
}

export default function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <main className="consent-shell">
      <div className="consent-card">
        <Link href="/" className="consent-brand">
          ◈ Agent Brain
        </Link>
        <p className="consent-eyebrow">AGENT CONNECTION</p>
        <h1>Give this agent access?</h1>
        <Suspense
          fallback={<output>Loading the authorization request…</output>}
        >
          <AuthorizedConsent searchParams={searchParams} />
        </Suspense>
      </div>
    </main>
  );
}
