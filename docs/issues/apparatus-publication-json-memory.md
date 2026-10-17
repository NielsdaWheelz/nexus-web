# apparatus publication can exhaust postgres memory

status: open; failure reconciled; bounded correction locally verified, not deployed

at deployed `695ddbd1f`, `reader_apparatus.replace_media_apparatus` serializes
every item into one `jsonb_to_recordset` upsert. live repair of `228d14cf` sent
the largest source projection. at 2026-10-17 15:48:57 utc, postgres backend34184
was killed during that statement. the kernel recorded the postgres container's
512 mib memory limit being exhausted. postgres terminated its other backends
and recovered at15:48:58; the repair command exited1. generation remained2.

impact: a large publication can interrupt ordinary database requests. the
complete stored source, generation, metadata, state/item/edge ids and all13
protected scopes match the saved before-state: the transaction fully rolled back.
all57 source/generation fences match seven accepted changes and50 unchanged
targets; no repair backend remains. accepted repairs must not be repeated.
private evidence: canonical-695ddbd1f/live-remaining55-proof.tar.gz and
live-228-reconciled.json.

resolve at the publication owner: bound statement payloads while preserving one
transaction, stable identities, complete projection and final notification.
qualify the largest changed publication under the actual512 mib database limit
with representative existing connections, then fresh inspection/no-op and
protected-state equality. do not increase host or database limits to hide the
unbounded statement.

local correction `b748a3ace` keeps the existing transaction and statements but
limits each json array to128 rows/512kib, or one larger valid row. the fresh
restored-production clone accepted09f and228 changed applies, complete proposals,
fresh inspection/no-op, exact identities,92 unrelated tables, both sequences and
all8 protected scopes. postgres stayed within512mib with20 additional idle
connections and zero oom events. private proof:
forward-fix-b748a3ace/write-rehearsal-accepted.json. production remains paused
until the combined read/display correction and exact forward deployment pass.
