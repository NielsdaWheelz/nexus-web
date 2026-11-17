# deferred: a held quotation beside the thumb-index field

unapproved proposal from the 2026-11-15 thumb-index exploration: display a held
reader selection with its source, then let note/ask combine it with a typed
gloss. the thumb index is implemented; this additional capture flow is not.

`apps/web/src/components/nexus/useNexusController.ts` currently passes plain
`running.text` to `captureToday`. that cannot preserve a quotation's return to
its exact source passage. the reader's `SelectionDock.tsx` already owns passage
actions; the proposal must not create a weaker duplicate capture path.

decision needed: whether the additional interaction is useful enough to add.
if approved, reuse canonical passage capture and prove that the saved quotation
and gloss return to the exact source. otherwise decline it and remove this
record. replacing the current use-text page is not an approved requirement.
