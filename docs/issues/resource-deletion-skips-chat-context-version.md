# resource deletion skips surviving chat context versions

status: open; source-confirmed, no concurrent reproduction
origin: 2026-10-16 details specification; main `48bc7fbad`
area: resource graph / deletion / context versions

`python/nexus/services/notes.py:141-157` deletes a page through graph cleanup.
`python/nexus/services/resource_graph/cleanup.py:54-111` deletes incoming
context edges, but bumps only the `links` lane for surviving user/highlight-note
endpoints. it neither locks surviving conversations nor bumps their `context`
version. normal context removal now does both at its context owner.

impact: deleting an attached resource changes a surviving chat's context
membership without advancing the version used to identify that membership.
admission now freezes the reference set returned by context assembly; that
separate fix does not repair graph teardown versions.

prerequisite/fix: make teardown obey the context owner's membership/version
contract, with explicit lock ordering across resource and conversation deletion.
this is outside the details presentation change; do not patch it in the reader.

lock order (resource references re-slice, 2026-10-19, main `d6b73c712`): the fix
needs a rule spanning chat admission and every teardown. admission locks the
conversation first (`python/nexus/services/chat/admit.py:323-325`), then, for a
reader quote, the media and the highlight (`admit.py:382-383`). highlight teardown
locks the media, then the highlight (`python/nexus/services/highlights.py:882-887`),
and only then reaches graph cleanup; bumping a surviving chat's context version
there would lock the conversation last. the two orders form a deadlock cycle, so a
local bump in `resource_graph/cleanup.py` is not a fix. live evidence: the refs
harness journey `refs/J10.deleting-an-attached-resource-advances-the-context-version`
(page delete: membership 2 -> 1 items, context version 3 -> 3).

acceptance: deleting an attached resource advances each affected surviving
chat's context version once; stale context commands detect the changed version.
ordinary detach, resource deletion and concurrent admission retain consistent
membership, with no lock-order regression. qualify through actual public writes.
