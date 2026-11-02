"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { runMaintenanceAction } from "@/lib/workspace/settings-actions";

export function OperationsControls({ active }: { active: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [refreshing, refreshTransition] = useTransition();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // The initial status is server-rendered. Refresh its RSC payload only while work is active.
  useEffect(() => {
    if (!active || pending || refreshing) return;
    const timer = setTimeout(() => {
      if (document.visibilityState === "visible") {
        refreshTransition(() => router.refresh());
      }
    }, 5000);
    const refreshOnVisible = () => {
      if (document.visibilityState === "visible") {
        refreshTransition(() => router.refresh());
      }
    };
    document.addEventListener("visibilitychange", refreshOnVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
  }, [active, pending, refreshing, router]);

  function run() {
    setError("");
    setNotice("");
    startTransition(async () => {
      try {
        const result = await runMaintenanceAction();
        if (result.error) setError(result.error);
        else
          setNotice(
            "Maintenance is running on Vercel. You can leave this page; results appear below.",
          );
      } catch {
        setError("Unable to start maintenance. Try again.");
      }
    });
  }

  return (
    <div className="mb-5">
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" disabled={pending} onClick={run}>
          {pending && <Spinner aria-hidden="true" />}
          Run maintenance
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={refreshing}
          onClick={() => refreshTransition(() => router.refresh())}
        >
          {refreshing && <Spinner aria-hidden="true" />}
          Refresh status
        </Button>
      </div>
      {notice && (
        <output className="mt-4 block text-sm text-primary">{notice}</output>
      )}
      {error && (
        <p className="mt-4 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
