# lectern http responses rebuild the owned wire

status: deferred · origin: 2026-10-04 reduction source audit, bbfd1df4 · area: lectern / typed wire

`apps/web/src/lib/lectern/client.ts:21–74` fetches unknown json and reconstructs
envelopes, snapshots and command results using `lectern/contract.ts:591–739`.
the server already owns these outputs in
`python/nexus/schemas/consumption.py:99–178,261–310`; the routes still return
`dict`/`ok` (`api/routes/lectern.py:50–74`). duplicated field ownership can drift.
no user-visible failure or runtime acceptance was observed in this source audit.

derive the owned http output shapes from generated components while retaining
domain normalization: branded identities, canonical action subjects,
footer-audio/display correlation, reader/listening state and sealed completion
handles. strict native descriptor ingress remains live at
`player/androidPlayerProtocol.ts:456`; listening-state and resonance callers
also use the shared contract. do not retire its decoders wholesale or change
queue, command, natural-end, undo or replay behavior.

resolved when: owned http shape reconstruction is gone, actual response bytes
and normalized values remain equivalent, and a real deck read plus admitted
command/same-id replay preserves order, identities, activation and durable
no-write replay. native playback and devices remain unverified unless
separately exercised.
