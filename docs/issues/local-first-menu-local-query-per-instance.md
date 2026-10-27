# identical pending native reads repeat work

native warm note navigation registers the same resource query from the pane body
and pane-title subscription. the serialized adapter executes both. each query
uses at least four bridge frames. these are independent consumers of the same
local projection, not two authorities over writing.

exact9f diagnostic `20261027-160646-834cd6c9fbb2` records both warm witnesses:
two identical kind/ref registrations, each followed by its queue registration,
precede the first query-job entry with no intervening serialized operation.
compiled-location and realm-clock checks pass; retained sequence310 and the
first64 pending commands remain unchanged. later runtime note/page subscriptions
are separate waves and cannot share that initial read. diagnostic timing is not
capacity acceptance.

share only consecutive identical reads still waiting to start in the existing
native queue. every intervening queue registration and the read's own start
must end eligibility. retain per-subscriber delivery/error/unsubscribe ownership;
never reuse running or completed results. resolve with reviewed ordering and
actual paired native qualification. full capacity remains tracked separately
in `local-first-native-capacity-qualification.md`.
