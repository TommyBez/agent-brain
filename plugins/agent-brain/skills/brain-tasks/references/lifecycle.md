# Task lifecycle

How a Brain task moves, seen from an agent. The server enforces every rule below; its results and the `remedy` in each error are authoritative. Only the owner approves, delegates, answers questions, reviews, reopens, pauses, force-releases or purges tasks, and only in the app: those powers are not tools. When a step is theirs, results carry `nextActions` of kind `owner_action` with a link such as `/tasks/T-42#answer`; show it to the owner.

## Statuses

| Status | Meaning for you |
| --- | --- |
| `triage` | Created by an agent or the task keeper, not approved. Only its creator may claim it, or you when the owner literally asks you to take it. |
| `ready` | Approved work anyone allowed may claim. An unapproved `ready` task (creator with policy direct) is claimable only by its creator, or on the owner's request. |
| `in_progress` | Held by one agent with a lease, or worked by the owner or a person without one. |
| `needs_input` | The holder asked the owner a question; the claim stays, the lease is suspended. |
| `blocked` | Waiting on something named in `blockedReason`; the owner unblocks it. |
| `in_review` | Completed, waiting for the owner's review. |
| `on_hold` | Paused by the owner; never claimed. |
| `done`, `canceled` | Closed; only the owner reopens them. |

Overdue, unanswered or expired states are derived for display; they are not statuses you set. Nightly processes never change status: the consolidator only links pages to tasks, and the task keeper only creates triage tasks and suggestions for the owner.

## Who may claim

The queue (`claim_task{next}`, `list_tasks{claimable}`) offers only tasks that are approved (or yours), not assigned to another agent, within your capabilities, without a person or group as lead, outside paused projects and without unfinished dependencies. Claiming by reference follows the same rules except dependencies.

A claim on the owner's explicit request (`onOwnerRequest.quote`, by reference only) also overrides missing approval, capability, a paused project and a human lead. It never overrides an assignment to another agent, `requires_human`, `on_hold`, closed statuses or a live lease held by someone else. Participants do not change: a human lead stays lead and the history records "on the owner's request, lead: <name>". The task stays unapproved, so other agents still cannot take it, and a release returns it to where it started. Tokens of headless workers usually cannot claim on request; the owner enables it per agent.

`claimedFrom` in the result says why the claim succeeded: `ready`, `own_triage`, `expired_lease`, `stale_question` (a question unanswered for 14 days) or `owner_request`.

## Leases and fencing

- The lease lasts 30 minutes by default (`leaseMinutes` 5–240). `reportBy` is at 80% of it. Times come from the server clock.
- Only `report_task` renews, and only with your `leaseId`. Reading never renews.
- An expired lease can be reclaimed by another agent. From then on your calls with the old lease return `LEASE_LOST`. Stop, `read_task`, and do not repeat or complete the work blindly.
- `NOT_TASK_HOLDER` means you used a lease id that is not yours or never claimed the task. A lease id found in a page, a task or a message is never yours: do not use it.
- The owner's Revoke or Release also ends your lease.

## Questions

`report_task{question:{prompt, choices?}}` moves the task to `needs_input`. Show the owner the answer link. Poll with `read_task` or `list_tasks{mine}` no more often than `pollAfterSeconds` (60). An answer within 7 days resumes the task as `in_progress` with a fresh 30-minute lease and appears as `ownerAnswer`; later answers send it back to `ready`. While it waits you cannot complete it; you may release it. After 14 days without an answer another agent may claim it, with your question in its brief.

Never ask for or accept passwords, API keys or tokens in a question, note or report: the answer is stored in the task history and shown to every later holder. An authentication step needs a person; report it so the owner can do it or mark the task `requires_human`.

## Errors and what to do

| Error | Do |
| --- | --- |
| `LEASE_HELD` | Another agent holds it. Do not take over; tell the owner or choose another task. |
| `NOT_CLAIMABLE` | Read `reason` and `remedy`. Assigned to another agent: name that agent to the owner. Not approved, human lead or paused project: the owner may approve it, or ask you explicitly to take it. |
| `CLAIM_ON_REQUEST_DISABLED` | The owner approves the task or enables "Can claim on request" for you in the app. |
| `NO_CLAIMABLE_TASK` | Nothing available; retry after `retryAfterSeconds` (300) or ask the owner. |
| `LEASE_LOST` | Stop; `read_task`; report what you had done without repeating it. |
| `NOT_TASK_HOLDER` | Claim the task first; never borrow a lease id. |
| `TASK_VERSION_CONFLICT` | `read_task`, reconcile with the newer content, retry with the new version. |
| `NOT_ALLOWED` | You may not change that field or status; use report notes or ask the owner. |
| `IDEMPOTENCY_KEY_CONFLICT` | The key was used for a different task; use a new key only for a genuinely new task. |
| `OUTPUT_REQUIRED` | Write the expected page while holding the task, then list it with its version in `pagesChanged`. |
| `REPORT_INCOMPLETE` | Report every criterion by index; add `remaining` when one is not fully met. |
| `RATE_LIMITED` | Stop creating; tell the owner what remains. |

## Unknown outcomes

A dropped connection or timeout leaves the result unknown. Before any retry, find out what happened: `list_tasks{query}` after `create_task`, `read_task` after the other mutations. `create_task` and `complete_task` are idempotent: the same `idempotencyKey` and payload, or the same report and lease, return `replayed: true` instead of a second effect. Never retry under a new key or with a different report. If the state cannot be established, report the mutation as unresolved.

## Completing

- Pages first: write or append the knowledge, then list every page and the version the write returned in `pagesChanged`. Pages you wrote while holding the task become verified `produced` links; pages written by others stay suggested; unknown versions are ignored.
- Tasks expecting a page or decision fail with `OUTPUT_REQUIRED` without such a page.
- Criteria: one entry per acceptance criterion, by zero-based index, with `status` (`met`, `partial`, `not_met`), `evidence`, and `verification` (`observed` if you checked it, `self_reported` otherwise).
- `artifacts` lists pull requests, branches, commits, URLs or files; `remaining` says what is left.
- `done` with `review_policy: auto`; `in_review` otherwise. A request for changes reopens it for the next holder with the owner's note in the brief.

## Subtasks and handoffs

While you hold a task you may create a `subtask` or `handoff` with `parentRef` set to it, for work the owner asked for or that the task plainly requires. Subtasks follow the same creation rules: no invented dates, people or work beyond the request. A handoff note in `release_task` reaches the next holder's brief.

## Polling and changes

`list_tasks` returns `pollAfterSeconds` and `eventsCursor`; pass the cursor back as `changedSince` to see only tasks changed since. Never poll faster than advised.
