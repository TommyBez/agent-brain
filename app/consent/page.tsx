import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getAuth, getSession } from "@/lib/auth";
import { ConsentActions } from "./consent-form";
import "./consent.css";

const permissions: Record<string, string> = {
  "brain:read": "Read and search your pages, links and context",
  "brain:write": "Create and update your pages with version control",
  "brain:maintain": "Maintain embeddings and run scheduled organization work",
  openid: "Identify your account",
  profile: "Read your display name",
  email: "Read your email address",
  offline_access: "Stay connected through refresh tokens",
};

async function AuthorizedConsent({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const requestHeaders = await headers();
  const session = await getSession(requestHeaders);
  if (!session) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (typeof value === "string") params.append(key, value);
      else if (Array.isArray(value))
        for (const item of value) params.append(key, item);
    }
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
  let name = clientId;
  let verified = false;
  try {
    const client = await getAuth().api.getOAuthClientPublic({
      query: { client_id: clientId },
      headers: requestHeaders,
    });
    name = client.client_name || clientId;
    verified = true;
  } catch {
    // Unavailable or unknown clients must not become actionable requests.
  }
  let identityHost = "";
  let localCallback = false;
  try {
    identityHost = new URL(
      clientId.startsWith("https://") ? clientId : redirectUri,
    ).host;
    localCallback = ["localhost", "127.0.0.1", "[::1]"].includes(
      new URL(redirectUri).hostname,
    );
  } catch {
    /* Provider validation controls invalid requests. */
  }
  return (
    <>
      <p>
        Signed in as {session.user.email}. Review the permissions before
        connecting this agent to your private brain.
      </p>
      <div className="consent-client">
        <strong>{identityHost || name || "Unknown client"}</strong>
        {name && name !== identityHost && <span>{name}</span>}
        <code>{clientId}</code>
        <span>Authorization returns to</span>
        <code>{redirectUri || "No callback provided"}</code>
      </div>
      {localCallback && (
        <p className="consent-note">
          This agent receives authorization on your computer. Continue only if
          you just started connecting that local application.
        </p>
      )}
      <ul className="consent-scopes">
        {scopes.map((scope) => (
          <li key={scope}>
            <span>{permissions[scope] || scope}</span>
            <code>{scope}</code>
          </li>
        ))}
      </ul>
      {claims.length > 0 && (
        <p>Additional identity fields requested: {claims.join(", ")}.</p>
      )}
      <p className="consent-note">
        Only approve agents you recognize. They will be able to use the
        permissions above on your behalf.
      </p>
      {verified ? (
        <ConsentActions />
      ) : (
        <p role="alert" className="consent-error">
          This authorization request could not be verified. Start the connection
          again from your agent.
        </p>
      )}
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
