# a refused refresh reads "This import changed" in Imports

status: open (copy)
origin: 2026-10-21 ingest follow-ups (item 1, L4)
area: imports pane (web copy)

since the follow-ups, a refresh its publication refuses (a note a chat or link
references would vanish, or the source's notes lost their identities) settles
failed `E_RESOURCE_CONFLICT` at once, and Imports shows the attempt as
NeedsAttention with that code. Imports words a failure by its code alone
(`importFailureCopy`, `apps/web/src/lib/imports/copy.ts`), and the
`E_RESOURCE_CONFLICT` copy is "Import changed. This import changed. Review its
current status.", written for an import whose work moved on. the server's message
("Source refresh cannot preserve a referenced note. The previous publication was
retained.") is not shown.

impact: the reader is told the import changed, not that the refresh would have
dropped a note they referenced, that the article stays readable, or that removing
the reference and refreshing again resolves it.

evidence: harness journey `F5.referenced-note-refresh-refusal-settles-L4`
(`2026-10-21/ingfix/harness`): import NeedsAttention `E_RESOURCE_CONFLICT`.

proposed fix: copy for a source attempt's `E_RESOURCE_CONFLICT` that names the
refused refresh ("Refresh kept the previous version. A note you referenced would
have been removed."), or a distinct code for publication refusals.

resolved when a refused refresh's Imports row says why it was refused and that the
previous version stays readable.
