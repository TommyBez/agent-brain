# Meetings and sources

Most work enters Agent Brain through sources: meeting minutes, call summaries, emails or reports saved as pages. This guide covers how tasks relate to them.

## Save the source, not tasks

When asked to save a meeting, record it with the brain-memory skill: a note for the meeting when it matters on its own, and updates to the projects, people and decisions it changes. Keep its action items in the note as written, with who committed to what, the due wording and any code such as `FU.01` or `AÜ.05`. Do not convert them into a checklist, add items nobody stated, or copy task status into the page.

Do not create tasks for those action items yourself. The task keeper, a nightly system process separate from the consolidator, reads every changed page and transcribes commitments explicitly written there (who, what, when) into `triage`, one batch per source, with the excerpt and a `source` link. The owner reviews the batch ("Approve all / Review"); tasks never start from a hypothesis, a proposal ("potremmo valutare…"), an agent's "next steps" or a gap. The owner can run it the same evening from Operations.

## When the owner asks you to track an item

If the owner explicitly asks you to track a specific item ("tieni traccia di FU.02", "crea un task per l'azione di Marta"):

1. Search with `list_tasks{query}` using the code and key words: the task keeper may already have transcribed it. Codes are only text in titles, descriptions and excerpts, so full-text search finds them.
2. If it exists, point the owner to it. Otherwise create one task with `origin: owner_request` and their words in `ownerQuote`.
3. Keep the code in the title or description as text; tasks have their own numbers (`T-42`). Never mirror external registers: one source item may need zero, one or several tasks, and a task may cite several sources.
4. Take the due date only from the source, quoted in `due.sourceExcerpt`: "entro il 16/10" is a date; "~30/10" is approximate; "alla prossima riunione" is an event with that text. "Data non fissata" stays unset. Never pick a date for the owner.
5. Do not invent assignees. Name people as the source does in the description; the owner sets leads and participants in the app, where external people are person pages or a group label such as "tutti".

## When sources disagree

Pages can disagree about the same item: one says closed on 14/10, another still lists it open. Do not choose a winner and do not edit the task to match one of them. Report the conflicting sources to the owner; the task keeper raises such cases as suggestions (`divergent_state`, `may_be_done`, `new_source`) that only the owner accepts. Preserve both attributed statements in the pages, per brain-memory.

## Recurring meetings and agendas

Recurring work (a weekly report, a meeting series) is an owner recurrence; the task keeper creates one instance per occurrence. Do not create instances yourself. To prepare the next meeting, read the tasks linked to its project with `list_tasks{projectRef}` (due at the meeting, overdue, closed since last time) and the meeting notes; the app also offers the agenda with "Copy as Markdown". An agenda you prepare is an answer in the conversation (or the app's "Copy as Markdown"), not a new task and not a page: never save task titles, references or statuses into page Markdown.

## Decisions taken in meetings

A choice adopted in a meeting belongs on a decision page (brain-memory). If an open task tracks that choice, completing it is the holder's job through `complete_task`; knowledge alone never closes a task, and a decision page does not mark the task done.
