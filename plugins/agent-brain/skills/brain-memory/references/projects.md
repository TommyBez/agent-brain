# Projects

Use `project` for a distinct initiative, engagement or product effort with its own objective and scope. A repository or domain can help identify it but does not, by itself, define its boundaries. Use [Choosing entities](choosing-entities.md) when distinguishing it from an organization or topic note.

## What belongs here

Retain the intended outcome, relevant scope and exclusions, stakeholders and responsibilities, requirements, constraints, dependencies and evidence-backed state. Preserve meaningful milestones, decisions and lessons that affect future work. Keep requested future actions when they actually come from the user or source; do not generate a backlog to compensate for missing information.

Distinguish the initiative from its company, people and publications. Keep organization-wide context on the company and a person's general role on their page. Reference consequential decision pages while retaining the short implications needed to understand the project's current direction.

## Writing and updating state

- Use a stable project name and supported aliases, including previous names when identity is continuous. Separate phases or repositories need new pages only when they are independently useful subjects, not merely because they have different paths.
- Organize around the outcome, scope, current supported state, constraints and relevant history when useful. Keep only sections justified by the available content.
- Date state claims and identify what was actually verified: proposed, implemented, deployed and verified behavior are different claims. A green build or successful deployment does not establish that the product journey works.
- Preserve bounded evidence. If only one role, environment or scenario was checked, retain that boundary instead of turning it into a general completion claim.
- Reconcile stale scope, milestones and summaries when a confirmed change supersedes them. Preserve prior commitments and the reason for changes when useful, without leaving incompatible statements presented as current.
- Keep durable domain constraints and consequential incident lessons. An agent's tool retry, failed save or running job belongs in operational state or the completion report unless it establishes useful knowledge about the project itself.

Project status, dates, responsibilities and environments are Markdown content; do not invent API fields for them.

## Links

Use `project → depends_on → project` for a real dependency, not a loose association. Use `part_of` when the project belongs to a larger initiative or organization. Use a labeled `relates_to` for involvement the available types cannot describe more precisely. Decision pages can point to this project with `decided_in`; backlinks provide reverse discovery without requiring another outgoing link.

## Example

"Portal's staging login was verified for administrators; production customer login remains untested." Record the exact environment and role if this changes useful project knowledge. Do not write "authentication complete" or invent an owner task to test production. A subsequent production verification can reconcile the state while retaining the relevant scope of the earlier evidence.
