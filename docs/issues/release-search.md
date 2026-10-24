# coordinated search release

integration target: main `9ca8d44e8`, schema0315, preserving current authored
identities, retention, online-first writing, account-scoped reads, tls/http2 and
removed dossier/link-note/author-editing contracts. the measured candidate is
preserved at `2cacaa3c2`; its observations are not relabeled as integrated proof.

read-only deployment inspection on2026-10-24 observed source `dc12792e` and
schema0312. its existing verified nightly backup is retained privately; recheck
actual ancestry and stopped-writer state at rollout. keep main's0306–0315 chain
unchanged and apply one0316 search conversion after it. earlier search0306/0307
identities and the0292 qualification clone cannot be stamped into this history.

0313/0314 remove author-editing/dossier state under their existing owner steps;
0315 adds consumption observation. qualify those intended changes separately
from0316 preservation. compare surviving canonical identities, text, vectors,
revisions/readiness and suggestion-clock state at0315 against0316. require exact
logical/native projection agreement across the fifteen surviving families.
no repair, reindex or provider call is hidden in conversion; invalid input refuses.

before migration, stop every writer and use the verified-backup deployment owner.
the infra-owned `POSTGRES_IMAGE` must point to the immutable pg15 image providing
pinned pg_search0.26.2 with preload; preserve512mib/no-swap and128mib shared memory.
the migration command uses `--no-deps`, so installing the extension at ordinary
application startup is too late. verify binary/catalog versions and exact head.
rollback restores backup plus paired binaries; no downgrade/mixed-version reader.

ship api, workers, hosted web and generated wire together. apply the wire bump
rule against the actual released pair, not an old recorded wire number. include
[endpoint/client cutover](release-desktop-lab.md), reload open clients after pending
writes settle, and retain main's account and installed-client admission rules.
api/worker expensive retrieval holds shared session admission through cleanup;
transaction-pooling proxies and old workers violate this contract. provider waits
and direct lookup remain outside admission. preserve stock asyncio and sdk import
preparation before readiness; the [native fault](search-api-segfault-on-launcher-workload.md)
remains unattributed with selected-runtime measured stability accepted.

warm visible-result p95 budgets remain500/2000/4000ms for direct/keyword/related;
cold keyword3000/related4000ms has one accepted control, not a percentile.
independent failure deadlines remain unchanged. the prior controlled candidate
passes book publication once, durable unrelated edits and scoped browser/merge
request observations. integrated static checks, populated conversion and the
affected search/publication journey remain required before release preparation
is complete; neither the checkpoint nor renumbering establishes those facts.

the owner accepts occasional restored-pane related failure during publication
conditional on verified honest failure, preserved useful results and retry.
that conditional check remains pending on the integrated build; no scheduler or
cutoff increase is authorized. preserve the [historical unjoined abort](search-hybrid-publication-cutoff.md).
manual screen-reader and unrestricted ordinary-worker qualification remain
explicitly deferred. give the [restored backlog](restored-search-worker-backlog.md)
its legitimate disposition; never blanket-cancel it to create acceptance.

after coordinated rollout, check independent phases, interaction-held refresh,
continuation, literal evidence/canonical activation, mobile ime and announcements,
and text publication before embeddings. release execution remains a separate
owner action. delete this issue after rollout and owner checks.
