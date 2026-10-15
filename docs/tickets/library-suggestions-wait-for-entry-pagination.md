# library suggestions wait for unrelated entry pagination

status: open (source-confirmed)
origin: 2026-10-14 suggestions specification, source `367da80e0`
area: web / library suggestions

`apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx:794`
mounts `SuggestionsSection` only when `list.complete`. a known library therefore
cannot load or explain its suggestions until its unrelated entry pagination
finishes. a failed or unfinished list can conceal suggestions indefinitely.

prerequisite: the suggestions read must independently check destination authority
and complete membership. mount from the known destination and applicable
authority; remove the entry-pagination dependency. implementation is specified in
the [suggestions plan](../suggestions-plan.md).

acceptance: with entry pagination delayed or failed, an authorized library still
shows suggestions or their own loading/error state. current membership and
permissions remain enforced by the suggestions owner and add command.
