# People

Use `person` for a real individual's identity, roles and relationship with the owner. Read [Choosing entities](choosing-entities.md) when placement is unclear; shared quality and authorization rules remain in `SKILL.md`.

## What belongs here

Retain the context that makes future interactions intelligible: how the owner knows the person, their relevant responsibilities, expertise, affiliations, stated priorities and meaningful collaboration history. Keep preferences only when they are stated or otherwise supported and useful to working with the person.

Put organization-wide policies in the company and initiative-specific scope or milestones in the project. A person page can explain their responsibility in that context and reference the detailed page. Attribute opinions to the speaker; one employee's comment is not automatically their company's position.

## Identity and presentation

- Distinguish namesakes using known organization, role, relationship or other evidence. A matching first name, email domain or similar spelling is not enough.
- Use the known preferred name as the title and supported name variants as aliases. Do not add generic roles such as "the CTO" as identity aliases.
- Distinguish a job title, actual responsibilities and decision authority. Do not infer hiring, purchasing or approval powers from seniority alone.
- If useful, organize the Markdown around relationship, current roles, relevant context and dated changes. These are optional sections; do not create empty biography fields or seek personal details just to fill a profile.
- Keep contact details and personal information proportionate to the task. Do not infer personality, health, beliefs or other sensitive traits from conversational fragments.

## Changes and links

When employment or responsibility changes, reconcile current wording and summary with the dated evidence while preserving useful history. Avoid making an old affiliation appear current simply because it was mentioned in a recent conversation.

Use `person → works_at → company` for supported current employment, not for a former employer, customer contact or external advisor without evidence of current employment. `collaborates_with` or a labeled `relates_to` may better describe other relationships. Use `owns` only when ownership is established; working on a project does not prove ownership.

Links do not carry structured employment dates, and a label such as "historical" does not change the meaning of a `works_at` edge. When evidence confirms that employment has ended, remove that edge through a reconciled `write`, preserving unrelated outgoing links and the dated employment history in Markdown. Replace it with another type only when evidence supports a relationship that remains true, such as ongoing collaboration. Do not infer that employment ended from silence or old source dates. Do not add a reverse link solely for navigation.

## Example

"Elena told the owner she moved from Acme to Beta in September and still advises Acme's Portal team." Remove Elena's `works_at` edge to Acme and add the supported current employment edge to Beta. Keep the dated Acme employment history in Markdown and represent the ongoing advisory relationship with a justified `collaborates_with` or labeled `relates_to` link. Do not merge the companies or transfer Portal to Beta on the strength of her move.
