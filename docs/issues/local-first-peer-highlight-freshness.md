# qualify peer annotations and remote admission

browser refresh is repaired and proved. account terminal-admission and
retired-response and wire-reload races pass; installed-client checks remain.

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

the account terminal-admission race passes in
`20261025-212216-4c293cc5ee65`. run `20261025-214933-7baa03b29f90`
on `509c47d69` passes real retirement with logout still pending: a held old
response rejects with `AbortError`. run `20261025-215552-e4d90ab07c7d`
on `6f9e41b48` passes the genuine wire race: a real 426 cannot navigate or emit
beforeunload while a local command is pending; late old success/failure cannot
reopen admission. after the retained command commits, explicit reload preserves
the exact text and uploads it.

resolve after installed-client peer create/edit/delete/reconnect.
the browser results do not substitute for the installed-client check.
