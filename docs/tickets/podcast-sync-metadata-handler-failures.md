# podcast sync metadata handler failures

status: owner-deferred (2026-10-14: leave brave unavailable and defer its work)
origin: 2026-10-14 production release observation, source b6768bee2
area: automatic metadata generation

the 11:15 utc podcast subscription sync admitted 205 metadata jobs. at 12:42,
131 succeeded, two ended dead with `E_METADATA_INVALID_OUTPUT`, 30 were failed
with `E_WORKER_HANDLER_FAILED`, 41 were pending and one was running. each
handler failure had used one of two attempts. api logs during the observed
interval contain only health-route get requests; no ui admission batch was
observed. the release's idle metadata/generation gate fails while this queue
runs. the exception is `RuntimeError: configured Brave binding violated host
policy`; every captured underlying web-search exception reports http 402.

evidence: campaign release private
`attempts/31d69ff7b/metadata-activity-census-1238.txt` and
`capacity-2g-reaudit-20261014/curated-activity-v2-20261014T124144Z.json`
(sha256 b52356b0d8f540c696b772dc7c201d854ebf2fe56878a701fd01a33ee2cee0b9).
the database census is a current row-state observation; log starts count
attempts, not distinct admissions. historical catalog failures are separate.

the pinned `llm-tools` brave adapter classifies 402 as `INVALID_REQUEST`, and
the web tool binding treats that code as a host-policy defect. payment-required
is a provider availability condition. fix its classification at that owner,
with a declared tool failure, correct attempt count and no automatic 402 retry;
keep invalid-key/request checks strict. this code work is explicitly deferred.
no library branch, worktree, code change, commit, pr or dependency-pin update
was made. preserve running or uncertain generations and existing admissions.
acceptance: ordinary
automatic metadata jobs settle to correct typed outcomes, the queue drains,
and no unexpected handler failure or orphaned generation remains. never
redispatch an uncertain original to make the release gate pass.

additional evidence: `capacity-2g-reaudit-20261014/brave-exception-causes-20261014T125313Z.json`,
sha256 `75554dd3ce6425f6a8b10a639223c89966ef4fc637c25bba94ec0b3e550d6ccd`.
72 distinct job fingerprints occur in 198 duplicated exception-chain entries;
those entries are not a provider-attempt count. a separate ordinary one-attempt
read using the pinned adapter and production inputs also returned http 402.

final 13:02 utc census: all 205 automatic jobs settled: 131 succeeded, 72 ended dead after two attempts with the brave host-policy handler error, and two ended dead with `E_METADATA_INVALID_OUTPUT`. running jobs, unfinished metadata jobs and outcome-null generations were all zero. no operator cancellation, retry or redispatch was used. queue settlement removes the release idle blocker; it does not resolve brave or the handler defect.
