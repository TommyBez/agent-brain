import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { SignInForm } from "@/components/sign-in-form";
import { isAuthConfigured } from "@/lib/auth";
import { safeReturnTo } from "@/lib/auth-navigation";
import type { RouteSearchParams } from "@/lib/workspace/urls";

async function RequestedSignIn({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const { returnTo } = await searchParams;
  return (
    <SignInForm
      callbackURL={safeReturnTo(typeof returnTo === "string" ? returnTo : null)}
    />
  );
}

export default function SignInPage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  return (
    <AuthGate
      configured={isAuthConfigured()}
      form={
        <Suspense fallback={<output>Loading sign-in form…</output>}>
          <RequestedSignIn searchParams={searchParams} />
        </Suspense>
      }
    />
  );
}
