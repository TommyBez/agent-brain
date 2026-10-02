"use client";

import { ErrorState } from "@/components/error-state";

export default function RootError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-svh max-w-lg items-center p-6">
      <ErrorState error={error} retry={retry} showHomeLink />
    </main>
  );
}
