"use client";

import { startTransition, useEffect, useState } from "react";
import { relativeTime } from "@/lib/formatters";

export function RelativeTime({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    const update = () => startTransition(() => setLabel(relativeTime(value)));
    update();
    const interval = setInterval(update, 60_000);
    return () => clearInterval(interval);
  }, [value]);

  return (
    <time dateTime={value} className={className}>
      {label ?? value.slice(0, 10)}
    </time>
  );
}
