# resource reference cutover

status: pending canonical rollout
origin: 2026-10-16 resource-reference implementation and main integration
area: release / resource evidence and client pairing

the integrated change requires wire 7 and migration 0290 after the chat viewer's
0289. it includes the chat controls, chat viewer and versioned selection popup
contracts already on main. merge alone does not admit this work to a release.

use the release owner's existing stopped-writer and verified-backup procedure.
0290 normalizes saved citation/retrieval evidence, converts oracle citation edges,
and adds admitted context versions. it preserves captured history, marks unproven
locations unavailable, and refuses conflicting saved identities or provenance.
there is no downgrade; recovery uses the verified backup. do not restart old
writers against the new schema.

pair api, workers, web, extension and apk under wire 7; verify schema head 0290.
settle pending commands and preserve unsaved reader/chat drafts before replacing
clients. old clients receive the wire-mismatch refusal. preserve the prerequisite
steps in [chat controls](release-chat-controls.md), [chat viewer](release-chat-viewer.md)
and [selection popup](release-selection-popup.md), using this final wire/schema.

the canonical coordinator retains rollout and book production writes. this work
is excluded from the book-repair release pinned to
`f4026846f857fd137e9c9e170faba05f07c5e282`; later main merges do not alter that pin.

resolved when the release owner qualifies the paired wire 7/schema 0290 build,
verifies preserved history and explicit old-client refusal, and deploys it through
the existing backup, migration and publication workflow.
