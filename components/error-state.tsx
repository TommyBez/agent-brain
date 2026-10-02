"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";

export function ErrorState({
  error,
  retry,
  title = "Something went wrong",
  description = "An unexpected error occurred. Please try again.",
  showHomeLink = false,
}: {
  error: Error & { digest?: string };
  retry: () => void;
  title?: string;
  description?: string;
  showHomeLink?: boolean;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Empty
      role="alert"
      className="border border-destructive/20 bg-destructive/5"
    >
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
        {error.digest ? (
          <EmptyDescription className="font-mono text-xs">
            Reference: {error.digest}
          </EmptyDescription>
        ) : null}
      </EmptyHeader>
      <EmptyContent className="flex-row justify-center">
        <Button onClick={() => retry()}>Try again</Button>
        {showHomeLink ? (
          <Button asChild variant="outline">
            <Link href="/">Back to home</Link>
          </Button>
        ) : null}
      </EmptyContent>
    </Empty>
  );
}
