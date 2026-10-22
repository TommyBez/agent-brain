import {
  ArrowRight,
  CircleCheck,
  CircleDot,
  Hand,
  Link2,
  Pencil,
  Sparkles,
} from "lucide-react";
import type { ReactNode } from "react";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import {
  Message,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from "@/components/ui/message";
import { RelativeTime } from "@/components/workspace/relative-time";
import type { TaskEventView } from "@/lib/tasks/records";
import { EVENT_LABELS, ORIGIN_LABELS, statusLabel } from "./labels";

const CONVERSATION = new Set(["reported", "asked", "answered", "note"]);

function markerText(event: TaskEventView): ReactNode {
  const actor = event.actor.kind === "owner" ? "You" : event.actor.label;
  const payload = event.payload as Record<string, unknown>;
  switch (event.action) {
    case "created": {
      const origin =
        ORIGIN_LABELS[payload.origin as keyof typeof ORIGIN_LABELS];
      return `${actor} created the task${origin ? ` (${origin})` : ""}`;
    }
    case "status_changed":
      return `${actor} moved it from ${statusLabel(event.fromStatus ?? "")} to ${statusLabel(event.toStatus ?? "")}`;
    case "claimed": {
      const request = payload.ownerRequest as { quote?: unknown } | undefined;
      return typeof request?.quote === "string"
        ? `${actor} claimed the task on your request: “${request.quote}”`
        : `${actor} claimed the task`;
    }
    case "edited": {
      const fields = Array.isArray(payload.changedFields)
        ? payload.changedFields.join(", ")
        : "";
      return `${actor} edited ${fields || "the task"}`;
    }
    case "reviewed":
      return payload.decision === "approve"
        ? `${actor} approved the work`
        : `${actor} requested changes`;
    case "released":
      return payload.forced
        ? `${actor} released the claim`
        : `${actor} released the task`;
    default:
      return `${actor} ${EVENT_LABELS[event.action] ?? event.action}`;
  }
}

const ICONS: Record<string, ReactNode> = {
  created: <Sparkles />,
  edited: <Pencil />,
  approved: <CircleCheck />,
  completed: <CircleCheck />,
  reviewed: <CircleCheck />,
  claimed: <Hand />,
  released: <Hand />,
  links_changed: <Link2 />,
  status_changed: <ArrowRight />,
};

function EventMarker({ event }: { event: TaskEventView }) {
  return (
    <Marker>
      <MarkerIcon>{ICONS[event.action] ?? <CircleDot />}</MarkerIcon>
      <MarkerContent>
        {markerText(event)} · <RelativeTime value={event.createdAt} />
      </MarkerContent>
    </Marker>
  );
}

function EventMessage({ event }: { event: TaskEventView }) {
  const owner = event.actor.kind === "owner";
  const payload = event.payload as Record<string, unknown>;
  const choices = Array.isArray(payload.choices)
    ? payload.choices.filter(
        (choice): choice is string => typeof choice === "string",
      )
    : [];
  return (
    <Message align={owner ? "end" : "start"}>
      <MessageContent>
        <MessageHeader>
          {owner ? "You" : event.actor.label}
          {event.action === "asked" && " asked"}
          {event.action === "answered" && " answered"}
        </MessageHeader>
        <Bubble
          variant={owner ? "default" : "muted"}
          align={owner ? "end" : "start"}
        >
          <BubbleContent className="whitespace-pre-wrap wrap-anywhere">
            {event.note}
            {typeof payload.choice === "string" && (
              <span className="mt-1 block text-xs opacity-80">
                Chose: {payload.choice}
              </span>
            )}
          </BubbleContent>
        </Bubble>
        {choices.length > 0 && (
          <MessageFooter>Choices: {choices.join(" · ")}</MessageFooter>
        )}
        <MessageFooter>
          <RelativeTime value={event.createdAt} />
          {event.untrusted && (
            <span className="ml-1">· written by an agent</span>
          )}
        </MessageFooter>
      </MessageContent>
    </Message>
  );
}

/** The task's history: conversation as messages, state changes as markers. */
export function TaskActivity({ events }: { events: TaskEventView[] }) {
  if (!events.length)
    return <p className="text-sm text-muted-foreground">No activity yet.</p>;
  return (
    <ol className="space-y-4">
      {events.map((event) => (
        <li key={event.id} className="space-y-2">
          {CONVERSATION.has(event.action) && event.note ? (
            <EventMessage event={event} />
          ) : (
            <>
              <EventMarker event={event} />
              {event.note && (
                <EventMessage event={{ ...event, action: "note" }} />
              )}
            </>
          )}
        </li>
      ))}
    </ol>
  );
}
