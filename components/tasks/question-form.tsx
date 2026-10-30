"use client";

import { useRef } from "react";
import { taskOperationAction } from "@/app/(workspace)/actions/tasks";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire";
import { Spinner } from "@/components/ui/spinner";
import { ActionError, useTaskAction } from "./action-state";

/**
 * The holder's question, answered as the owner. With choices the first step
 * picks one and the second adds an optional note; without, one free answer.
 */
export function QuestionForm({
  taskRef,
  version,
  inputRequestedAt,
  prompt,
  askedBy,
  choices,
  stale,
}: {
  taskRef: string;
  version: number;
  /** When this question was asked: an answer never reaches a newer one. */
  inputRequestedAt: string | null;
  prompt: string;
  askedBy: string | null;
  choices: string[];
  stale: boolean;
}) {
  const form = useRef<HTMLFormElement>(null);
  const { pending, error, run } = useTaskAction();
  const withChoices = choices.length > 0;
  const description = askedBy ? `Asked by ${askedBy}.` : undefined;

  return (
    <Questionnaire
      ref={form}
      aria-label={`Answer the question on ${taskRef}`}
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const answer = String(data.get("answer") ?? "").trim();
        const choice = String(data.get("choice") ?? "").trim();
        if (!answer && !choice) return;
        run(() =>
          taskOperationAction(taskRef, "answer", {
            expectedVersion: version,
            inputRequestedAt,
            answer: answer || undefined,
            choice: choice || undefined,
          }),
        );
      }}
    >
      {withChoices && (
        <QuestionnaireItem name="choice" required>
          <QuestionnaireTitle className="font-medium whitespace-pre-wrap wrap-anywhere">
            {prompt}
          </QuestionnaireTitle>
          {description && (
            <QuestionnaireDescription>{description}</QuestionnaireDescription>
          )}
          <QuestionnaireChoices>
            {choices.map((choice) => (
              <QuestionnaireChoice key={choice} value={choice}>
                {choice}
              </QuestionnaireChoice>
            ))}
          </QuestionnaireChoices>
        </QuestionnaireItem>
      )}
      <QuestionnaireItem name="answer" required={!withChoices}>
        <QuestionnaireTitle className="font-medium whitespace-pre-wrap wrap-anywhere">
          {withChoices ? "Anything to add? (optional)" : prompt}
        </QuestionnaireTitle>
        {!withChoices && description && (
          <QuestionnaireDescription>{description}</QuestionnaireDescription>
        )}
        <QuestionnaireInput
          placeholder="Your answer"
          maxLength={4000}
          autoComplete="off"
        />
      </QuestionnaireItem>
      <p className="text-xs text-muted-foreground">
        Do not paste passwords, keys or tokens: answers stay in the task history
        and reach later agents.
      </p>
      {stale && (
        <p className="text-xs text-muted-foreground">
          This question waited more than 7 days: answering returns the task to
          the queue with your answer in its brief.
        </p>
      )}
      <QuestionnaireActions>
        {withChoices && <QuestionnairePrevious size="sm" />}
        {withChoices && <QuestionnaireNext size="sm" />}
        <QuestionnaireSubmit size="sm" disabled={pending}>
          {pending && <Spinner aria-hidden="true" />}
          Send answer
        </QuestionnaireSubmit>
      </QuestionnaireActions>
      <ActionError error={error} />
    </Questionnaire>
  );
}
