"use client";

import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";

export function PasswordSettings() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  async function changePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const result = await authClient.changePassword({
        currentPassword: String(fields.get("currentPassword")),
        newPassword: String(fields.get("newPassword")),
        revokeOtherSessions: true,
      });
      if (result.error)
        throw new Error(result.error.message || "Unable to change password.");
      form.reset();
      setSaved(true);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to change password.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={changePassword} className="space-y-5">
      <FieldGroup className="gap-5 sm:grid sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="current-password">Current password</FieldLabel>
          <Input
            id="current-password"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="new-password">New password</FieldLabel>
          <Input
            id="new-password"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            minLength={12}
            placeholder="At least 12 characters"
            required
          />
        </Field>
      </FieldGroup>
      <FieldError className="text-xs">{error}</FieldError>
      {saved && (
        <output className="block text-xs text-primary">
          Password changed. Other browser sessions have been signed out.
        </output>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? <Spinner aria-hidden="true" /> : <ShieldCheck />}
        Update password
      </Button>
    </form>
  );
}
