# chat connections overstate admitted context

source baseline: `69c00182c8328f46cec893517971f87f03cdbf16`; still present at `origin/main` `ff57128842b470510446b3edca54922ebcace41e` on 2026-10-16. line numbers refer to the original baseline unless stated otherwise.

status: open
origin: 2026-10-16 resource presentation architecture audit
area: chat / connections / context membership

problem: the chat's linked-items pane lists all incident graph facts while
claiming that its items are available to future replies. some displayed
resources are not members of the admitted chat scope.

evidence: `apps/web/src/components/chat/Conversation.tsx:186-190` mounts
`ConnectionsSurface`. that surface queries both directions with owner rollup
and no origin filter (`components/connections/ConnectionsSurface.tsx:80-85`),
then makes the future-replies claim at line 143. the actual membership law
admits incident user links and outgoing bare citation/system facts only
(`python/nexus/services/resource_graph/context.py:44-66`). it deduplicates
targets at their first attachment rank (lines 70-82), unlike the pane's
newest-first fact list. admission freezes this narrower membership
(`services/chat/admit.py:449-455`).

reachable case: annotate a user link between a chat and a media resource.
`services/resource_graph/links.py:110-137` creates incoming `link_note` edges
from the note to both endpoints. the chat's generic query displays that note,
but `context_facts_sql` excludes it. embedding a chat in a note similarly
creates an incoming `note_body` fact (`services/note_bodies.py:181-192`).
these are supported writers, not hypothetical malformed rows. source trace
only; no live mutation or generation was run.

prerequisites: preserve the canonical context-membership law and frozen-run
scope. select context roots through that law and render them with the shared
resource primitive. keep generic graph adjacency available through disclosure
or an explicitly separate relation view; expanding it must not attach context.
do not broaden model scope merely to make the current copy true.

acceptance: a chat with ordinary links, automatic context, and a note on a
link shows the exact admitted resources in its context roots, once each and
in attachment order. the note remains discoverable as a relation but is not
presented as model context until explicitly attached. future sends freeze
exactly the shown context membership; existing runs remain unchanged.
