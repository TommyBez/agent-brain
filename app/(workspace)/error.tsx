"use client";

import { ErrorState } from "@/components/error-state";

export default function WorkspaceError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <ErrorState
      error={error}
      retry={retry}
      title="Unable to load this view"
      description="Your knowledge is temporarily unavailable. Please try again."
    />
  );
}
