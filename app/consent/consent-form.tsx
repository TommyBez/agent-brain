"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function ConsentActions() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
      {error && (
        <p role="alert" className="consent-error">
          {error}
        </p>
      )}
      <div className="consent-actions">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => decide(false)}
        >
          Cancel
        </Button>
        <Button type="button" disabled={busy} onClick={() => decide(true)}>
          {busy ? "Connecting…" : "Allow access"}
        </Button>
      </div>
    </>
  );
}
