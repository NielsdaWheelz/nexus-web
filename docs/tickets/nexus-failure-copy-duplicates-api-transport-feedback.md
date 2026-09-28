# nexus failure copy duplicates apiTransportFeedback

status: open · origin: 2026-09-28 nexus launcher rewrite (size/nexus-launcher-web) · area: nexus / api client

`FAILURE_COPY` and `nexusFailure` in `apps/web/src/lib/nexus/useNexusFind.ts` map
`E_NETWORK`, `E_UPSTREAM`, `E_UPSTREAM_TIMEOUT` and `E_RATE_LIMITED` to their own copy
("Check your connection and retry.", "Nexus couldn’t complete the request. Wait a moment,
then retry.", "Wait a moment, then retry."). `apiTransportFeedback` in
`apps/web/src/lib/api/client.ts` already owns those four codes, with different words
("…try again."). two owners of one policy, drifting in wording only. the rewrite kept the
Nexus copy because the live suite pinned it verbatim. no route the Nexus calls has ever
emitted `E_RATE_LIMITED` (the deleted limiter covered chat send, oracle create and
stream-token mint; see [web-rate-limit-copy-outlives-limiter](web-rate-limit-copy-outlives-limiter.md)),
so the Nexus arm is dead copy.

impact: about 15 lines, and transport copy that reads differently in the Nexus than
everywhere else.

fix: build the history-write, page-create and library-create feedback from
`apiTransportFeedback` and keep only the non-transport codes (`E_FORBIDDEN`,
`E_LIBRARY_FORBIDDEN`, `E_INVALID_REQUEST`, `E_NAME_INVALID`, `E_RESOURCE_CONFLICT`) in the
Nexus table. accept the wording change.

resolved when: `rg "E_NETWORK|E_UPSTREAM" apps/web/src/lib/nexus apps/web/src/components/nexus`
finds nothing, and a failed history write, page create and library create still show a
Retry with the shared copy on both viewports.
