import {
  Circle,
  CircleDot,
  CircleHelp,
  CirclePause,
  CircleSlash,
  Eye,
  Inbox,
  type LucideIcon,
} from "lucide-react";
import type { TaskStatus } from "@/lib/tasks/types";

const statuses: Partial<
  Record<TaskStatus, { label: string; icon: LucideIcon }>
> = {
  triage: { label: "Triage", icon: Inbox },
  ready: { label: "Ready", icon: Circle },
  in_progress: { label: "In progress", icon: CircleDot },
  needs_input: { label: "Needs input", icon: CircleHelp },
  blocked: { label: "Blocked", icon: CircleSlash },
  in_review: { label: "In review", icon: Eye },
  on_hold: { label: "On hold", icon: CirclePause },
};

export function taskStatusLabel(status: TaskStatus) {
  return statuses[status]?.label ?? status.replaceAll("_", " ");
}

export function taskStatusIcon(status: TaskStatus): LucideIcon {
  return statuses[status]?.icon ?? Circle;
}
