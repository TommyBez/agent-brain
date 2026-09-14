"use client";

import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";

const permissions: Record<string, string> = {
  "brain:read": "Read and search your pages, links and context",
  "brain:write": "Create and update your pages with version control",
  "brain:maintain": "Maintain embeddings and run scheduled organization work",
  openid: "Identify your account",
  profile: "Read your display name",
  email: "Read your email address",
  offline_access: "Stay connected through refresh tokens",
};

export function ConsentForm({
  clientId,
  scopes,
  claims,
  redirectUri,
}: {
  clientId: string;
  scopes: string[];
  claims: string[];
  redirectUri: string;
}) {
  const [name, setName] = useState(clientId);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
  useEffect(() => {
    let active = true;
    authClient.oauth2
      .publicClient({ query: { client_id: clientId } })
      .then(({ data, error }) => {
        if (!active) return;
        if (error || !data) {
          setError(
            "This authorization request could not be verified. Start the connection again from your agent.",
          );
          return;
        }
        setName(data.client_name || clientId);
        setVerified(true);
      });
    return () => {
      active = false;
    };
  }, [clientId]);
  async function decide(accept: boolean) {
    setBusy(true);
    setError("");
    try {
      // The client plugin forwards and the server verifies the complete signed OAuth query.
      const response = await authClient.oauth2.consent({ accept });
      if (response.error) {
        setError(response.error.message || "Could not complete authorization.");
        return;
      }
      if (response.data?.url) window.location.assign(response.data.url);
      else
        setError(
          "Authorization did not return a redirect. Start the connection again.",
        );
    } catch {
      setError("Could not reach the authorization service.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
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
      {error && (
        <p role="alert" className="consent-error">
          {error}
        </p>
      )}
      <div className="consent-actions">
        <button
          type="button"
          disabled={!verified || busy}
          onClick={() => decide(false)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="consent-approve"
          disabled={!verified || busy}
          onClick={() => decide(true)}
        >
          {busy ? "Connecting…" : "Allow access"}
        </button>
      </div>
    </>
  );
}
