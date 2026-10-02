# Choosing entities

Read before deciding where to save knowledge. The type guides linked from `SKILL.md` explain what to retain and how to evolve each kind of page. API payloads belong to [Writing pages](writing-pages.md).

## Find the canonical home

Separate the information's subject from its source. A conversation, meeting or document may supply facts about several entities; its format does not determine their page types.

- Ask what a future retrieval would be about: a person, an organization, an initiative, a publication, a choice, or a reusable topic. Resolve those subjects and read the relevant existing pages.
- Place each fact where its scope belongs. A company's general procurement policy belongs to the company; a delivery constraint for one engagement belongs to that project. A person's role belongs to the person, with links to the relevant organization or project.
- Keep shared detail in one canonical home. Other pages may retain a short attributed implication or the local context needed to understand it, with a reference to the detailed page. Do not copy the full passage across every linked entity.
- Resolve identities before splitting or combining them. A company and its product can be different subjects; a renamed project can be the same subject. A repository, domain, meeting title or acronym alone does not establish identity or justify a new page.

## Update or create

Prefer an existing page when the information extends its subject. Create a page when it represents a distinct subject that is useful to retrieve independently and no existing page fits. Length alone does not justify a split; a small fact can still describe a distinct person, and a long passage can still belong to one project.

For closely related types:

- **Company or project:** the continuing relationship with an organization belongs to the company; the objective, deliverables and constraints of a particular initiative belong to its project.
- **Project or decision:** routine implementation details can remain in the project. Give a consequential choice its own decision page when the rationale, scope or effects deserve independent retrieval; link it from its project context.
- **Project or note:** a note is useful when the subject is a synthesis, method or meeting record worth retrieving as such. An ordinary progress update belongs to the project.
- **Article or note:** an article represents a particular external publication. A note represents the owner's or agent's synthesis; attribute and reference the publications it uses. A URL alone does not make a page an article.
- **Decision or note:** an adopted choice is a decision; a comparison, hypothesis or proposal is usually a note or part of the relevant project. A requested decision register may include a proposed choice, but its status must remain explicit.

Use `note` for an identified knowledge subject, not as a default inbox for information whose home has not been investigated. Existing page types are context: do not automatically reclassify older pages or create competing pages to impose these conventions. If reorganization is authorized, preserve their identity, distinct content and source associations through the supported tools.

## Choose the smallest useful set of changes

A single conversation can justify several page updates, one update, or none. Save only supported new knowledge or useful corrections within the user's authorization. Do not create every mentioned entity or introduce empty pages merely to complete a graph.

The following examples are fictional routing cases, not instructions to save their entities:

| Information | Canonical placement |
| --- | --- |
| Elena now leads procurement at Acme. | Elena's person page; a justified `works_at` link to Acme. |
| Acme requires an annual supplier review for all engagements. | Acme's company page. |
| The Portal initiative must launch before Acme's November campaign. | Portal's project page, with the source and applicable date. |
| Portal will use managed hosting because the team cannot staff operations; the owner adopts this tradeoff. | A decision page if its rationale merits one; a short implication in Portal. |
| A published essay argues for managed hosting. | An article page when the publication itself is worth retaining; attributed claims stay there. |
| The owner develops a hosting-selection method from several sources. | A note referencing those sources, linked to projects where it applies. |
| A meeting only repeats Portal's known deadline. | No new page or duplicate update. |

Do not force an unrelated entity link. When a named subject cannot be resolved, preserve a supported textual attribution if useful; creating its page requires the same identity and usefulness assessment as any other creation.
