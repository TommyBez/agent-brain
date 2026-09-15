"use client";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
export function SignInForm() {
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
        callbackURL: "/",
      });
      if (result.error)
        throw new Error(
          result.error.message ??
            "Unable to sign in. Check your email and password.",
        );
      window.location.assign(result.data?.url || "/");
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
      <Label>
        Email address
        <Input
          type="email"
          name="email"
          autoComplete="email"
          placeholder="you@example.com"
          required
        />
      </Label>
      <Label>
        Password
        <Input
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder="Your password"
          required
        />
      </Label>
      {error && (
        <p
          className="message [border:1px_solid_#d9dece] [background:#edf0e5] p-[16px_18px] rounded-[6px] [font-size:13px] m-[18px_0] error"
          role="alert"
        >
          {error}
        </p>
      )}
      <Button
        type="submit"
        variant="default"
        className="button bg-transparent [border:1px_solid_#d8dbcf] rounded-[6px] p-[10px_15px] inline-flex items-center justify-center gap-2 leading-[1.3] font-medium [font-size:12px] min-h-[39px] [transition:background_.15s,_border-color_.15s,_transform_.15s] whitespace-nowrap primary wide"
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
