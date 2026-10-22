"use client";

import { Timer } from "lucide-react";
import { startTransition, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";

function remaining(expiresAt: string, now: number) {
  const seconds = Math.round((new Date(expiresAt).getTime() - now) / 1000);
  if (seconds <= 0) return { label: "Lease expired", expired: true };
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const label =
    hours > 0
      ? `${hours}h ${String(minutes % 60).padStart(2, "0")}m left`
      : `${minutes}:${String(seconds % 60).padStart(2, "0")} left`;
  return { label, expired: false };
}

/** The holder's lease, counted down in the browser (the server's clock decides). */
export function LeaseCountdown({
  expiresAt,
  holder,
}: {
  expiresAt: string;
  holder?: string | null;
}) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => startTransition(() => setNow(Date.now()));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, []);
  const state = now === null ? null : remaining(expiresAt, now);
  return (
    <Badge
      variant="outline"
      className={state?.expired ? "text-destructive" : undefined}
    >
      <Timer aria-hidden="true" />
      {holder ? `${holder} · ` : ""}
      <time dateTime={expiresAt} className="tabular-nums">
        {state?.label ?? "Lease active"}
      </time>
    </Badge>
  );
}
