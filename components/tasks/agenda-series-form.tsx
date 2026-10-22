"use client";

import { Pause, Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import {
  createMeetingSeriesAction,
  setMeetingSeriesPausedAction,
} from "@/app/(workspace)/tasks/agenda/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { TASK_LIMITS } from "@/lib/tasks/types";

const WEEKDAY_OPTIONS = [
  ["MO", "Monday"],
  ["TU", "Tuesday"],
  ["WE", "Wednesday"],
  ["TH", "Thursday"],
  ["FR", "Friday"],
  ["SA", "Saturday"],
  ["SU", "Sunday"],
] as const;

/** A weekly meeting series for a project; its agenda follows the next meeting. */
export function AgendaSeriesForm({
  projects,
}: {
  projects: { id: string; title: string }[];
}) {
  const id = useId();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [weekday, setWeekday] = useState("MO");
  const [weeks, setWeeks] = useState(1);
  const [time, setTime] = useState("09:00");
  const [startsOn, setStartsOn] = useState("");

  if (!projects.length)
    return (
      <p className="text-sm text-muted-foreground">
        A meeting series belongs to a project. Create a project page first.
      </p>
    );

  const field = "space-y-2";
  return (
    <form
      className="max-w-3xl space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await createMeetingSeriesAction({
            title,
            projectId,
            weekday,
            interval: weeks,
            time,
            startsOn,
          });
          if (!result.ok) {
            setError(result.message);
            return;
          }
          setTitle("");
          router.push(`/tasks/agenda?series=${result.id}`);
        });
      }}
    >
      <div className="grid gap-6 sm:grid-cols-2">
        <div className={field}>
          <Label htmlFor={`${id}-title`}>Meeting</Label>
          <Input
            id={`${id}-title`}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={TASK_LIMITS.title}
            placeholder="e.g. Weekly steering"
            required
          />
        </div>
        <div className={field}>
          <Label htmlFor={`${id}-project`}>Project</Label>
          <NativeSelect
            id={`${id}-project`}
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            required
          >
            {projects.map((project) => (
              <NativeSelectOption key={project.id} value={project.id}>
                {project.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </div>
      <div className="grid gap-6 sm:grid-cols-4">
        <div className={field}>
          <Label htmlFor={`${id}-weekday`}>Weekday</Label>
          <NativeSelect
            id={`${id}-weekday`}
            value={weekday}
            onChange={(event) => setWeekday(event.target.value)}
          >
            {WEEKDAY_OPTIONS.map(([value, label]) => (
              <NativeSelectOption key={value} value={value}>
                {label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className={field}>
          <Label htmlFor={`${id}-interval`}>Every (weeks)</Label>
          <Input
            id={`${id}-interval`}
            type="number"
            min={1}
            max={8}
            value={weeks}
            onChange={(event) => setWeeks(Number(event.target.value))}
            required
          />
        </div>
        <div className={field}>
          <Label htmlFor={`${id}-time`}>Time</Label>
          <Input
            id={`${id}-time`}
            type="time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
          />
        </div>
        <div className={field}>
          <Label htmlFor={`${id}-starts`}>Starting</Label>
          <Input
            id={`${id}-starts`}
            type="date"
            value={startsOn}
            onChange={(event) => setStartsOn(event.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending || !title.trim()}>
          {pending && <Spinner aria-hidden="true" />}
          Create meeting series
        </Button>
        {error && (
          <span role="alert" className="text-sm text-destructive wrap-anywhere">
            {error}
          </span>
        )}
      </div>
    </form>
  );
}

/** Pausing hides the next meeting; resuming starts again from today. */
export function AgendaSeriesPause({
  id,
  paused,
}: {
  id: string;
  paused: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await setMeetingSeriesPausedAction(id, !paused);
            if (!result.ok) setError(result.message);
            else router.refresh();
          });
        }}
      >
        {pending ? (
          <Spinner aria-hidden="true" />
        ) : paused ? (
          <Play size={16} aria-hidden="true" />
        ) : (
          <Pause size={16} aria-hidden="true" />
        )}
        {paused ? "Resume series" : "Pause series"}
      </Button>
      {error && (
        <span role="alert" className="text-sm text-destructive">
          {error}
        </span>
      )}
    </>
  );
}
