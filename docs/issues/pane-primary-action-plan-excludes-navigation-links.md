# planned primary actions exclude navigation links

status: specified; awaiting implementation qualification
origin: 2026-10-16 principal-action source audit
area: web / pane chrome / proposed contract

the earlier unimplemented creation plan restricted `PanePrimaryAction` to command
descriptors (`docs/libraries-creation-plan.md:88-96`). the current chats and
podcasts principal tasks are link descriptors:
`apps/web/src/app/(authenticated)/conversations/ConversationsPaneBody.tsx:60-67`
and `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx:54-61`.
using that command-only slot for those tasks would require a second
slot or converting navigation into a button, losing native link behavior.

prerequisite: the principal-action scope includes these existing navigation
tasks. preserve the existing library creation flow and descriptor ownership.
the principal-actions plan (#651) now extends the one optional primary publication to the existing link/command union,
with only the presentation metadata its actual callers need. render links as
anchors and commands as buttons; do not add an action registry or infer commands
from labels. the creation plan has been reconciled; qualification remains part of implementation.

acceptance: new chat and browse remain real links with normal, modified-click
and copy-link behavior in desktop and mobile chrome. new library and add
content remain commands receiving the actual trigger for focus return. one
publication supports all four without a second execution path.
