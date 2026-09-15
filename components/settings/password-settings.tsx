"use client";

import { LoaderCircle, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Label
          htmlFor="current-password"
          className="flex flex-col items-start gap-2 text-xs"
        >
          Current password
          <Input
            id="current-password"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
          />
        </Label>
        <Label
          htmlFor="new-password"
          className="flex flex-col items-start gap-2 text-xs"
        >
          New password
          <Input
            id="new-password"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            minLength={12}
            placeholder="At least 12 characters"
            required
          />
        </Label>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {saved && (
        <output className="block text-xs text-primary">
          Password changed. Other browser sessions have been signed out.
        </output>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? (
          <LoaderCircle className="animate-spin" size={15} />
        ) : (
          <ShieldCheck size={15} />
        )}{" "}
        Update password
      </Button>
    </form>
  );
}
