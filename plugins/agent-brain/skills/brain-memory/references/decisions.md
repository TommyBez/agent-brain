# Decisions

Use `decision` for an adopted choice that guides future work on approach, scope, technology, priorities or operating rules. Create or update its own page even when the project already exists. Routine execution details and progress remain in the project. Use [Choosing entities](choosing-entities.md) for routing examples.

## Recognize a decision

Look for a confirmed direction that future work should respect: choosing a hosting approach, excluding a customer segment, prioritizing one phase over another, or adopting an operating rule. The user need not say "save a decision" or provide a formal alternatives analysis. A brief statement such as "for this product, we will support only regulatory affairs" can establish a decision; retain exactly that scope.

Resolve the choice itself, not just the project name, and read any existing decision before creating another. Keep the choice and supported rationale on the decision page and the short practical implication on the project. The `decided_in` link makes the decision discoverable from its project through backlinks; do not copy the full rationale into both pages.

## Establish what was decided

An option being discussed, recommended by an agent or selected for an experiment is not evidence of a broader adopted choice. Retain who made or confirmed the choice and the source when known. Distinguish the decision from its implementation: adopting a plan does not establish that it has shipped.

An explicitly adopted experiment can itself be a decision when it sets direction for a bounded phase; record that boundary without presenting its tested option as the permanent choice. A one-off tool selection or bug fix is ordinarily an execution detail, not a new direction.

A proposed choice normally belongs in a note or the relevant project. If the user requests a decision register that includes proposals, make proposed status explicit in the title, summary and Markdown where needed; do not phrase it as adopted. Status is content, not a separate API field.

## What to preserve

Keep the choice, its applicable project or domain, date when known, motivations, material alternatives actually considered, constraints, accepted tradeoffs and consequences. Preserve exceptions, conditions and any revisit trigger actually agreed. Do not reconstruct a full alternatives analysis from hindsight or add review dates that nobody committed to.

Use a title that identifies the choice and subject, such as "Managed hosting for Portal". Useful Markdown sections can cover choice and status, context and rationale, tradeoffs and consequences, and later changes. Include only supported material; a valid decision need not have every section.

An unexplained choice may still be useful. Retain it with honest attribution instead of inventing its rationale or turning the absent rationale into a new human task.

## Update or supersede

Clarifying the same choice, adding a supported rationale or correcting its wording usually belongs on the existing decision page. Implementation progress belongs primarily to the project unless it changes understanding of the decision itself.

A materially different adopted choice may deserve a new page. Use `new decision → supersedes → old decision` when the replacement is established, and preserve the earlier rationale and applicable period. Make current applicability clear where needed through authorized reconciled updates; the link alone does not correct an old page's misleading summary.

Do not treat a narrower exception as a wholesale replacement. Preserve its scope and link related choices appropriately. Do not resolve attributed disagreement by assuming the most recently edited page reflects the latest decision.

## Links and example

Use `decision → decided_in → project` for a choice made in that project's context. A broader choice may use labeled `relates_to` links to affected entities. Use `references` for a retained source supporting the rationale.

"The owner selects managed hosting for Portal because the team cannot staff operations, accepting the higher recurring cost." Retain the decision, stated rationale and tradeoff, linked to Portal. If later the owner adopts self-hosting for a new operational context, assess whether this replaces the original choice or applies only to a separate environment before using `supersedes`.
