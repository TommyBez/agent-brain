"use client";
import { ArrowRight } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
export function SignInForm({ callbackURL = "/" }: { callbackURL?: string }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result = await authClient.signIn.email({
        email: String(form.get("email")),
        password: String(form.get("password")),
        callbackURL,
      });
      if (result.error)
        throw new Error(
          result.error.message ??
            "Unable to sign in. Check your email and password.",
        );
      // A signed MCP authorization flow can return its own provider redirect.
      window.location.assign(result.data?.url || callbackURL);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to sign in.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={signIn}>
      <FieldGroup className="gap-6">
        <Field>
          <FieldLabel htmlFor="sign-in-email">Email address</FieldLabel>
          <Input
            id="sign-in-email"
            type="email"
            name="email"
            autoComplete="email"
            placeholder="you@example.com"
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="sign-in-password">Password</FieldLabel>
          <Input
            id="sign-in-password"
            type="password"
            name="password"
            autoComplete="current-password"
            placeholder="Your password"
            required
          />
        </Field>
        <FieldError>{error}</FieldError>
        <Button
          type="submit"
          variant="default"
          className="w-full"
          disabled={busy}
        >
          {busy && <Spinner aria-hidden="true" />} Sign in{" "}
          <ArrowRight size={17} />
        </Button>
        <FieldDescription>
          This is a private workspace. Accounts are provisioned by its owner.
        </FieldDescription>
      </FieldGroup>
    </form>
  );
}
