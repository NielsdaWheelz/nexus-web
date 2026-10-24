# coordinated search release

release is blocked on [main migration integration](release-search-main-migration-collision.md).
this checkout's 0306/0307 identities collide with main's chain. integrate current
canonical contracts first, then express the accepted conversion in one migration
after the actual main head. the populated search-branch migration proof does not
qualify that conversion. do not deploy the local migration files onto main.

ship api, workers, hosted web and generated wire together; reload open clients.
recheck the actual released pair and apply the once-per-release wire rule.
preview requires direct/lexical/hybrid; full search requires lexical/hybrid.
there is no compatibility reader, old cursor or semantic-unavailable success.

stop writers and take a verified backup through the deployment owner. install
pinned pg_search 0.26.2 and its preload before migration: the migration command
uses `--no-deps`. retain postgres 512 mib/no-swap and 128 mib shared memory. verify
binary/catalog versions and exact integrated head before restarting writers.
the conversion must preserve canonical passage/span identities, vectors,
revisions and lexical readiness, validate active-model vector coverage, rebuild
derived occurrences and preserve the legacy suggestion-clock baseline. reject
unconvertible data. recovery restores the verified backup and paired binaries;
there is no downgrade or mixed-version operation.

deploy endpoint/client settings through [the desktop transport cutover](release-desktop-lab.md).
existing embedding credentials enable related matches; startup prepares local
sdk imports before readiness without network calls. missing credentials leave
text searchable and related search explicitly unavailable. retain stock asyncio;
its measured stability is accepted with the [unattributed native fault](search-api-segfault-on-launcher-workload.md)
still open. this release performs no production account operation implicitly.

api and worker expensive retrieval share session advisory admission. connections
must remain bound to one postgres session through consumption and cleanup;
transaction-pooling proxies and old workers bypass this contract. direct lookup
and provider waits remain outside admission. source-owner clocks and fresh
serializable write attempts replace global publication exclusion.

accepted warm visible-result p95 budgets are direct 500/keyword 2000/related 4000 ms;
retain faster historical baselines. direct covers titles, names and aliases;
body/saved-text evidence arrives later. cold keyword 3000/related 4000 ms bounds
have one accepted control, not a cold percentile. failure deadlines remain
separate and unchanged. the controlled transaction proof establishes one book
commit and prompt durable unrelated edits; the separate request-overlap proof
observes native merging. affected browser/publication verification passes with
canonical literal evidence and scoped restoration. these are bounded observations,
not a new cohort or a fresh whole-corpus audit.

retain the [restored-pane related timeout](search-restoration-latency-tail.md)
and [unjoined historical abort](search-hybrid-publication-cutoff.md) as disclosed
limits. manual screen-reader and unrestricted-worker qualification remain
explicitly deferred; a scoped publication case does not qualify ordinary workers.
give the [restored worker backlog](restored-search-worker-backlog.md) its legitimate
disposition; never blanket-cancel it to manufacture acceptance. extension
ownership remains with [the canonical image](search-index-extension-ownership.md).

after the integrated conversion and coordinated rollout, check phase delivery,
interaction-held refresh, continuation, canonical activation, literal alias
evidence, mobile ime, announcements and text publication before embeddings.
production execution remains a separate owner action. delete this issue after
rollout and owner checks; preserve historical results under their original sources.
