# unreadable media connections counts stay loading

problem: when no document mounts, reader connections never settle. filter counts
stay a dash, described as `count loading`, for as long as the pane is open.

impact: unreadable media and failed documents still publish connections, and for
unreadable media that pane is the only surface for local highlights and links.
assistive technology hears a load that will never finish. the empty state also
stays in its incomplete copy, so a complete local inventory cannot say so.

evidence: source review on branch `reader-margin`, not reproduced in a browser. paths are
under `apps/web/src/app/(authenticated)/media/[id]/` unless stated.
`MediaPaneBody.tsx:486` calls `store.bind(null)` for a failed or unreadable
document. `annotations.ts:193` returns from `readRemote` when nothing is mounted,
so `remote` keeps its initial `{status: "loading"}` from `annotations.ts:126`.
unreadable media never starts the reader at all
(`apps/web/src/lib/documentReader/DocumentReader.tsx:172`).
`evidence/EvidencePane.tsx:445-446` then leave `remoteComplete` and `complete` false,
and `:497-499` select the `count loading` description.

proposed fix: give a null document a terminal remote state at the
`createMediaAnnotations` owner, so counts read as unavailable or exact.

resolved when an unreadable media item and a failed document each settle their
filter counts and empty state without a remote read, and a later readable
publication still reads remote evidence normally.
