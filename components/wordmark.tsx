import { cn } from "@/lib/utils";

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <span className="shrink-0 pb-1 font-serif text-[3rem] leading-none italic text-brand">
        a
      </span>
      <span className="text-[17px] font-medium tracking-tight">
        native brain
      </span>
    </span>
  );
}
