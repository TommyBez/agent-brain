# Companies

Use `company` for an organization the owner deals with, including clients, prospects, former employers and ordinary contacts. A particular engagement or product initiative may warrant its own project; use [Choosing entities](choosing-entities.md) for that boundary.

## What belongs here

Retain the organization's relevant activities and priorities, how the owner relates to it, established commercial context and policies applying across engagements. Explain useful history with dates and sources. Keep a particular project's deliverables, progress and technical decisions on that project's page; the company can reference the engagement and its significance.

Distinguish legal entities, brands, subsidiaries and products using evidence. Preserve supported names, domains and aliases without treating a shared brand or email domain as proof that two organizations are identical. A rebrand can be one entity; an acquisition does not automatically erase the acquired entity's identity or history.

## Relationship metadata

Only company pages accept the `relationships` array. It describes the owner's relationship to the organization, not a person's employment:

| Value | Use when supported |
| --- | --- |
| `client` | The organization is a client of the owner. |
| `prospect` | The owner is pursuing a potential client relationship. |
| `former_employer` | The organization previously employed the owner. |
| Empty array | None of the supported relationships is established, including a plain contact. |

Values can coexist: a former employer may become a client. Multiple values require evidence of each relationship; they are not a history of every past stage. Reconcile them when the relationship changes and describe prior stages in Markdown. A prospect becoming a client does not by itself justify retaining `prospect`; retain it only if a separate ongoing prospect relationship is supported.

Do not manufacture values such as `partner`, `supplier`, `employer` or `former_client`. Describe relationships the schema cannot express in Markdown. An employee's former employer is not the owner's `former_employer`. A meeting, friendly introduction or unsigned offer does not establish a client relationship.

## Presentation and links

Useful sections can cover relationship, relevant business context, engagements and dated history. Preserve actual conditions, budgets and commitments with their scope; do not turn a tentative budget into an agreed contract. Attribute an individual's statement unless there is evidence they speak for the organization.

Employment links originate from people: `person → works_at → company`. A project may `part_of` a company if it is genuinely an organizational initiative, while a commission or collaboration may be better represented by labeled `relates_to`. Use `company → owns → project` only for established ownership; being the client is not sufficient. Keep missing or uncertain ownership in the attributed text rather than encoding it as fact.

## Example

"Acme, the owner's former employer, signed a Portal engagement after a sales discussion." Reconcile Acme's metadata to the supported `former_employer` and `client` relationships and date the transition in its Markdown. Put Portal's delivery scope and constraints in Portal. Preserve the sales history without keeping an obsolete prospect label merely as an archive.
