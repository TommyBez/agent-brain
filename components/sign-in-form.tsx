"use client";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
    <form
      className="stack-form flex flex-col gap-[21px] mt-8"
      onSubmit={signIn}
    >
      <div className="grid gap-2">
        <Label htmlFor="sign-in-email">Email address</Label>
        <Input
          id="sign-in-email"
          type="email"
          name="email"
          autoComplete="email"
          placeholder="you@example.com"
          required
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="sign-in-password">Password</Label>
        <Input
          id="sign-in-password"
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder="Your password"
          required
        />
      </div>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <Button
        type="submit"
        variant="default"
        className="w-full"
        disabled={busy}
      >
        {busy ? <LoaderCircle className="spin" size={16} /> : null} Sign in{" "}
        <ArrowRight size={17} />
      </Button>
      <p className="form-note [font-size:11px] text-muted-foreground font-normal leading-[1.65]">
        This is a private workspace. Accounts are provisioned by its owner.
      </p>
    </form>
  );
}
