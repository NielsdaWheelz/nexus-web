# selection history can fail the whole workspace

- status: open
- origin: 2026-09-13 second-tab crash investigation; local sha `7fa89b88c8342bca9edfb46a6d20053c49555fb2`, deployed sha `7e8fd48244b3b436965037738e05785bb4931be1`
- area: nexus selection journal and failure containment

`apps/web/src/lib/nexus/useNexusSelectionJournal.ts:8` delays accepted
selection writes by 500 ms after two animation frames; line 74 posts
`/api/me/nexus-selections`. `apps/web/src/components/nexus/useNexusController.ts:304`
rethrows same-system defects and unexpected history errors. lines 484–485
store that error, and line 1876 throws it during the shell-mounted nexus
render. `apps/web/src/app/(authenticated)/AuthenticatedShell.tsx:165` mounts
nexus outside pane boundaries. history failure can therefore replace all
healthy panes after navigation has already succeeded. deployed source has
the same chain at controller lines 457–481 and 1876.

this timing fits the reported delayed workspace fallback, but the failing
production response/stack has not been captured; it is not a confirmed root
cause of that report.

later user evidence identifies concurrent 502 failures and same-pane
navigation; the incident's supported path is recorded in
`second-tab-gateway-outage-classified-as-workspace-defect.md`. this ticket
remains a separate confirmed containment defect.

prerequisites: capture the original production exception, request id, response
code, and build id; preserve strict error classification and replay-safe
selection identities.

proposed fix: put selection persistence and its defect boundary below a
narrow nexus/history owner. keep the original cause observable; stop the
failed capability and offer explicit recovery while preserving workspace
panes and drafts. repair the underlying endpoint/contract if the captured
error proves one. do not turn contract defects into ordinary network errors.

acceptance: inject an unexpected selection-write failure after opening a
second pane on desktop and mobile; both panes and unsaved drafts survive,
the error is reported once with its request context, and explicit recovery
replays the same mutation identity without a second history count.
demonstrate regression sensitivity through `./scripts/test`.
