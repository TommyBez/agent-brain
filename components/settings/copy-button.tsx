"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setError(false);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(true);
    }
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-2">
      {error && (
        <span role="alert" className="text-xs text-destructive">
          Select the text to copy manually.
        </span>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        onClick={copy}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </span>
  );
}
