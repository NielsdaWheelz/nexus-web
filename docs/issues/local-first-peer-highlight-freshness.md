# qualify peer annotations and remote admission

browser behavior is repaired and proved; installed-client freshness and delayed
account/admission races remain unqualified.

own highlights belong to the local authored corpus. readable peers belong to the
server document map and never enter that corpus. previously the browser hint
owner discarded `annotations_revision`, so peer writes did not refresh an open
map. the repair carries the existing opaque token on ordinary authored pull and
emits one dedicated annotation event. no new polling, persisted token or writing
watermark is involved. cached map projection preserves failure/retry state until
a successful remote read replaces it.

real red on `dc4467ee3`, run `20261025-191710-26f7763b06b3`: a peer created a
highlight after the initial map settled empty; the viewer's head did not advance,
the peer remained absent from the owned corpus, and no paint appeared in 45 seconds.

that fix exposed an admission defect: a failed refresh marked the browser
unavailable, then the api guard blocked manual retry before transport. run
`20261025-195750-960fdbc31f87` observed `Unavailable` at the actual api guard
with the trusted retry handler on its stack and no request dispatched.

browser demand requests can now test reachability while background readiness
remains separate. only a current-account parsed success recovers unavailable
admission. checking/sign-in/update fences and native authority remain intact;
retired responses cannot change the replacement account's state.

run `20261025-211531-a0460035a27e` on `b1b09675f` passes real peer creation,
cached paint through failed refresh, an actual retry request and changed color,
then peer deletion across reconnect without losing committed offline writing.

resolve after the installed client repeats peer create/edit/delete and reconnect,
and real delayed success/failure responses cannot reopen terminal admission or
survive account retirement. the browser result does not substitute for those
remaining checks.
