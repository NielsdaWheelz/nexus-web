# chat details omit admitted context references

status: open
origin: 2026-10-16 chat details review; revalidated on main `48bc7fbad`
area: chat / historical context projection

`python/nexus/services/chat/context.py:175-194` renders admitted references but
adds only references with a citation to `attached`. `chat/reads.py:320-351,392`
projects attached retrievals as the context list;
`apps/web/src/components/chat/AssistantTrust.tsx:157-166` presents that subset.

impact: a resource can have been supplied as a reference without appearing in
details. the list must not claim to be the complete prompt or proof that full
resource bodies were read.

prerequisite: define context here as saved resource references for the run, not
an inventory of the full prompt. derive the list from frozen `generation_spec.tool_scope`
(`python/nexus/services/chat/admit.py:485-491`), supplementing it with existing
retrieval labels/locations and current access-aware navigation. do not use today's
mutable conversation connections or parse the stored prompt into a new schema.
keep unavailable historical facts explicit; do not fabricate original labels or
attachment ordering. admission currently reads context twice; fix the
[snapshot disagreement](chat-admission-context-reads-can-disagree.md) before
claiming exact prompt/reference agreement for new runs. older scope records
remain saved scope, not proof of the complete prompt. no new persistence is
needed for this contract. the final shape and ownership are in the
details specification (#647).

acceptance: citable, label-only, unindexed and missing admitted references are
accounted for; changing conversation connections cannot rewrite an old run's list.
the list has no ordinals or routine included badges. actual tool reads remain
actions, distinct from supplied references and answer citations.
