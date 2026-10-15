# suggestions publication verification

status: implemented, verified and cleaned up, 2026-10-15.
branch: `codex/suggestions-publication`; baseline: `367da80e0c1b`.
final application: `2a856b824e22736d7176b1d900e5c4df04080569`;
ordinary next build: `JCBY1ucZaC5-ri1ZsaC_m`.
backend qualification began at `fde33a16367b`, interaction qualification at
`e8312f80e7a2`; receipts preserve that provenance. backend files are identical
through the final artifact; its affected frontend cases were rerun. no production
operation or deployment was performed.

## result and evidence

ranking now runs on the existing fenced background queue. get/view serve bounded,
currently authorized candidates. quick reads retain their direct owner. the
[specification](suggestions-plan.md) owns behavior and explicit costs;
[the module](modules/suggestions.md) owns the operational contract.

| acceptance | observed proof |
|---|---|
| independent behavioral reds | old reads wait on a real embedding lock; empty/loading states disappear; accepted additions remain during a held read; full capacity returns no candidates. later built-ui reds reproduce publication discovery through `/view` and stale capacity after another client frees space. |
| publication and current facts | eight concurrent admissions join one job; exact conditional delivery, 30-second availability, retained old-pool order, finished/membership/subscription/visibility filtering, malformed refs, authority loss/restoration, and teardown pass. |
| failure and concurrency | three actual lock failures, using a disclosed 250 ms harness lock timeout, suspend the same job; source changes and explicit refresh cannot replace it; same-job repair succeeds. obsolete claims publish nothing. source commit overlaps first registration and a worker snapshot; the older publication remains visibly dirty and admits no inactive successor. a real cursor blocked behind fenced reader publication rejects its stale generation, then succeeds against the new one without stuck locks. |
| source commits | 23 actual writer cases prove counter-last ordering, committed notifications, quiet same-anchor heartbeats and exact replays. [input inventory](verification/suggestions/inputs-inventory.md) names detection and commit owners. |
| ranking and content | independent baseline/current processes share one exported snapshot. first ten match for lectern, ordinary and default libraries; quick reads are byte-identical. the normal 448 mib worker produces a genuine mixed 80-ref pool. |
| authenticated observation | 13 checks cover listener-before-reread, admission/publication/history/repair wakeups, unchanged-state suppression, and terminal withdrawal on role loss/deletion. |
| transport | actual header/body holds expire at about 10 seconds with `E_UPSTREAM_TIMEOUT`; two transient failures share one budget with the third attempt. caller abort stays `AbortError`. actual sse and media transfers continue beyond ten seconds. |
| final built interaction and browser cost | 29 interaction checks pass; final affected-case checks cover named/default adds, independent server seeds, filtered entries and later pagination. all nine copied-corpus rendered-content timings meet one second. |

sanitized receipts: [backend](verification/suggestions/backend.json),
[source and corpus](verification/suggestions/inputs-and-corpus.json),
[frontend](verification/suggestions/frontend.json),
[transport](verification/suggestions/transport.json).
these are observations, not executable tests.

adversarial review covered the contracts, each implementation boundary and live
failures. review found and repaired discovery of new publications through `/view`,
a stale capacity veto, default-library command ownership and coupled server seeds.
the last repair preserves successful metadata/suggestions seeds when entry
prefetch misses; it uses existing cache keys and adds one cheap server read.

## declared performance setup

an owned remote copy contains 766 media and 717,006 embeddings, schema `0279`,
postgres physical identity `7696786006199500844`. postgres is limited to 512 mib,
with 64 mib shared buffers and jit disabled; api and worker each have a combined
448 mib limit. normal invitation/password authentication is used. no copied
historical provider jobs are dispatched: remote ranking uses the real queue
claim, `JobWorker._run` and child executor restricted to this job kind. the
separate small local stack proves the unmodified ordinary worker entrypoint.

20 sequential authenticated reads per surface and three concurrent requests:

| surface | api p95 | concurrent maximum | actual pool |
|---|---:|---:|---:|
| lectern | 163 ms | 175 ms | 26 |
| ordinary library | 56 ms | 75 ms | 1 |
| default library | 18 ms | 31 ms | 0 |
| quick reads, unchanged owner | 228 ms | 224 ms | 5 |

an additional 80-target `/view` returns all refs in order while both embedding
and graph tables are locked: p95 135 ms, maximum 340 ms; three concurrent requests
peak at 172 ms. its service trace contains 16 statements and zero embedding/graph
acquisitions. no padding or fabricated publication supplies this width proof.

three full-document navigations per destination on the final built artifact:

| surface | rendered content, ms |
|---|---|
| lectern, ten rows | 339, 349, 344 |
| ordinary library, one row | 403, 656, 667 |
| default library, successful empty | 760, 846, 744 |

a preinstalled in-page observer measures from navigation `performance.timeOrigin`
to the second animation frame with nonzero content geometry in the active pane.
locator polling is excluded. this method first exposed a genuine 1,188ms miss;
independent library server seeds repaired it. final accepted additions remove
and refill locally in 104ms for default and 149ms for named libraries while
subsequent reads are held; displayed survivors retain order.

separate background builds take 5.3–13.8 seconds and peak at 186 mib, without oom.
these are build durations, not a queue-wait guarantee. actual warm cursor saves
take 203–260 ms on the copy; five unchanged-anchor heartbeats preserve the revision.

## scope and limits

- three small tables, a global counter and broad invalidation keep ownership
  explicit. source commits briefly serialize. fresh explicit no-op commands may
  invalidate conservatively; exact replay and unchanged heartbeats stay quiet.
- relevance can age; authority and eligibility are checked at each read snapshot.
  the existing serial worker cannot promise first-build completion time. active
  destinations own refresh; dead work requires diagnosis and same-job repair.
- copied-corpus library pools are small or empty. mixed-family fixtures establish
  full-width ranking separately; the copied corpus establishes acquisition cost.
- hidden-document and changed-browser-clock branches are source-reviewed; actual inactive-pane disposal and naturally aged clean publications are exercised live. no operating-system kill during ranking is claimed; actual stale-claim fencing, retries and repair are exercised.
- the ten-second total budget applies to suggestions only. the wider
  [ordinary-read deadline issue](tickets/browser-read-deadline-does-not-cover-response-body.md)
  remains open.
- built next post cancellation also logs an inherited reset on the unchanged
  stream-token control. [the separate ticket](tickets/next-built-post-disconnect-logs-uncaught-reset.md)
  records the discriminator; no global exception suppression was added.
- deleting the requested temporary campaign removes future automated regression
  detection. the permanent gate remains the unchanged `./scripts/test`.

## completion record

final built checks and adversarial review pass. the unchanged `./scripts/test`
passes after campaign deletion; [static receipt](verification/suggestions/static.json)
records the exact application identity. later changes are documentation only.
six resolved suggestion tickets are deleted; wider issues remain registered.

temporary tests, on-disk fixtures, profiles, private credentials, relays and build
copies are deleted. [local cleanup](verification/suggestions/cleanup-local.json)
and [remote cleanup](verification/suggestions/cleanup-remote.json) record exact
ownership checks. all four task volumes and their data remain; storage containers
are stopped and retained for recovery. the local three storage services exited
cleanly; the copied corpus also retains its verified postgres identity and clean
shutdown state. campaign data remains in those volumes at the owner's request.
no prune, reset, deployment or production operation occurred.
