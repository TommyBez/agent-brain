import {
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
  ChevronUp,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { priorityLabel, statusLabel } from "./labels";

/** Status text colors as whole class names, so Tailwind can see them. */
export const STATUS_TEXT: Record<string, string> = {
  triage: "text-status-triage",
  ready: "text-status-ready",
  in_progress: "text-status-in-progress",
  needs_input: "text-status-needs-input",
  blocked: "text-status-blocked",
  in_review: "text-status-in-review",
  on_hold: "text-status-on-hold",
  done: "text-status-done",
  canceled: "text-status-canceled",
};

export function StatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  return (
    <Badge variant="secondary" className={cn(`status-${status}`, className)}>
      {statusLabel(status)}
    </Badge>
  );
}

const PRIORITY_STYLE: { icon: LucideIcon; className: string }[] = [
  { icon: ChevronsUp, className: "text-priority-urgent" },
  { icon: ChevronUp, className: "text-priority-high" },
  { icon: ChevronDown, className: "text-priority-normal" },
  { icon: ChevronsDown, className: "text-priority-low" },
];

export function PriorityLabel({
  priority,
  compact = false,
  className,
}: {
  priority: number;
  compact?: boolean;
  className?: string;
}) {
  const style = PRIORITY_STYLE[priority] ?? PRIORITY_STYLE[2];
  const Icon = style.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap",
        style.className,
        className,
      )}
    >
      <Icon size={14} aria-hidden="true" />
      <span className={compact ? "sr-only" : undefined}>
        {priorityLabel(priority)}
      </span>
    </span>
  );
}

/** Marks text that an agent or process wrote: reference data, not instructions. */
export function AuthoredBy({
  authored,
  className,
}: {
  authored: { untrusted: boolean; authoredBy: string };
  className?: string;
}) {
  if (!authored.untrusted) return null;
  return (
    <span className={cn("text-xs text-muted-foreground", className)}>
      Written by {authored.authoredBy}
    </span>
  );
}
