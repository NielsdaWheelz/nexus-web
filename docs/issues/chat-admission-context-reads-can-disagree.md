# chat admission context reads can disagree

status: open; source-inferred, not reproduced concurrently
origin: 2026-10-16 chat details review; revalidated on main `48bc7fbad`
area: chat / admission / context snapshot

`python/nexus/services/chat/context.py:175` reads prompt references;
`python/nexus/services/chat/admit.py:485-491` rereads them for frozen tool scope.
admission locks the conversation (`:324-325`). normal context removal now shares
that lock (`services/resource_graph/context.py:190`, `edges.py:303-321`), so the
earlier automatic-detach example is resolved.

resource teardown still bypasses it: `services/notes.py:141-157` deletes pages
through `services/resource_graph/cleanup.py:54-111`, which removes incoming
context edges without locking surviving conversations. page deletion's
serializable transaction does not give admission's normal session one snapshot
across its two reads. paths are under `python/nexus/`.

impact: removal between the two reads can leave a reference in the stored prompt
but absent from the stored tool scope. that also prevents treating historical
scope as a proven exact prompt inventory. no race was executed in this review.

prerequisite: keep prompt/scope admission at one owner. have `context.assemble`
return the identities it already read and construct `generation_spec.tool_scope`
from that same set. no new table, prompt parser or broad isolation change is
needed. this establishes prompt/scope membership agreement without promising
that later access or resource content cannot change. the independent
[teardown version gap](resource-deletion-skips-chat-context-version.md) remains
owned by graph cleanup.

acceptance: a context removal overlapping admission cannot make the admitted
prompt's reference set differ from its frozen scope. ordinary add/remove
behavior remains valid; historical rows are not silently rewritten.
