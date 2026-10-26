# owner docs contradict local writing

`docs/architecture.md` retains online-only note writing, deleted
`notes/texts.ts`/`writes.ts` paths and orphan deletion on unlink (§8.7).
`docs/modules/workspace.md` still describes server-dependent authored startup
through deleted `bootstrap.server.ts`. these statements contradict the local
store and independent-endpoint contracts and can induce incorrect maintenance.

the current-main composition also introduces complete/recency pages wording
(architecture §8.11–8.12); the approved local index remains title/ref ordered,
paginated and timestamp-free. correct the owning paragraphs and dead references
with that composition. resolve after checking them against actual module owners;
do not duplicate the specification or carry obsolete paths as alternatives.
