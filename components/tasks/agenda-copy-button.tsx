"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/** "Copy as Markdown": the agenda text built on the server. */
export function AgendaCopyButton({ markdown }: { markdown: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2500);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(markdown);
            setState("copied");
          } catch {
            setState("failed");
          }
        }}
      >
        {state === "copied" ? (
          <Check size={16} aria-hidden="true" />
        ) : (
          <Copy size={16} aria-hidden="true" />
        )}
        {state === "copied" ? "Copied" : "Copy as Markdown"}
      </Button>
      <span aria-live="polite" className="sr-only">
        {state === "copied"
          ? "Agenda copied as Markdown."
          : state === "failed"
            ? "The browser did not allow copying."
            : ""}
      </span>
      {state === "failed" && (
        <span role="alert" className="text-sm text-destructive">
          Copy failed; allow clipboard access and try again.
        </span>
      )}
    </>
  );
}
