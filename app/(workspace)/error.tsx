"use client";

import { Button } from "@/components/ui/button";

export default function WorkspaceError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/20 bg-destructive/5 p-6"
    >
      <h2>Unable to load this view.</h2>
      <p className="my-3 text-sm text-muted-foreground">
        Your knowledge is temporarily unavailable. Please try again.
      </p>
      <Button onClick={retry}>Try again</Button>
    </div>
  );
}
