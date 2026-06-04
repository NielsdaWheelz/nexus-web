# Podcast Subsystem Ownership Hard Cutover

## Status

Proposed hard-cutover spec. This document owns the production-ready plan to
**finish** the half-completed decomposition of the podcast/subscription/sync
package: collapse every duplicated owner to one, close the correctness bugs the
duplication has already produced, and replace untyped service surfaces with
typed contracts.

The implementation is a hard cutover. There is no legacy mode, no compatibility
alias, no dual code path, no silent fallback, no test-only seam on a private
symbol, and no backward-compatibility shim. When two modules can mutate the same
state today, exactly one owns it after this cutover and the other is deleted.

This is **not** a feature project. The podcast feature (discovery, subscribe,
OPML, sync, episodes, chapters, listening state, transcription, playback queue)
already works end-to-end and is covered by integration/real-media/live-provider
tests. What is unfinished is the *ownership cutover*: the package has the target
file names but the god-files remain and the boundaries leak.

### Validation log

Validated against live code on 2026-06-03 (8-agent survey + direct reads).
Confirmed: the six private `transcripts.py` imports in `sync.py:65-72`; the
unlocked YouTube co-owner (`tasks/ingest_youtube_video.py:460`); the
`library_entries` ownership + tie-break divergence; the inline serial poll
(`sync.py:282`); the `last_request_reason` CHECK omission (`models.py:3164-3169`
allows only `episode_open, search, highlight, quote, background_warming,
operator_requeue`; `0038` added `rss_feed` to `ck_podcast_transcription_jobs_request_reason`
and `ck_podcast_transcript_versions_request_reason` but not this one);
`podcast_transcript_chunks` orphan status (not in the ORM, zero runtime/test
references; lifecycle = create `0024` → backfill `0026`/`0027`).

Corrections folded in below: (a) the transcript-version write runs under **READ
COMMITTED** — `use_serializable_if_available` is applied only by the scheduler
enqueue (`worker.py:279`), never by job execution — so the advisory lock is
required and does **not** breach `concurrency.md §13`; (b) the `embedding_config_hash`
formula is `sha256("{provider}:{model}:{dims}:block_token_v2")`, not
`openai_{model}_{dims}_v1`; (c) next free migration is **0129** (head is
`0128_oracle_plate_storage_key_contract`); (d) `PodcastDetailPaneBody.tsx` is
2025 L; (e) the unified writer must own the `fragments`/`highlights` disposition
(idx-bump vs delete diverges across paths); (f) the unsubscribe **classification
read** of `library_entries`/`memberships` must move to libraries too, not just
the writes; (g) the current RSS path passes `last_request_reason=None`
(`sync.py:1096`) deliberately — the migration is mandatory because the new writer
*introduces* the `rss_feed` write, not because a violation is latent today.

Second validation pass (2026-06-03, 10-agent re-survey) reversed two earlier
diagnoses and added one structural move: (h) the version-write race is **not** a
corruption risk — `uq_podcast_transcript_versions_media_no` + the partial
`uix_..._media_active` already make duplicate/dual-active rows uncommittable; the
live defect is the unlocked YouTube writer racing *itself* and, lacking
`IntegrityError` handling, rolling back a successful transcript (Problem #2);
(i) the poll is **not** dead-lettered while inline work runs — the heartbeat renews
its queue lease; the real hazard is the staleness windows admitting a second
concurrent poll/sync that double-writes (Problem #4, Key Decision 8); (j) the SSRF
fix **lifts** the repo's existing DNS-resolving guard
(`image_validation.validate_dns_resolution`), not a green-field build — refined by
(m) below (Problem #5); (k) the
active transcript version is stored twice (`is_active` vs
`media_transcript_states.active_transcript_version_id`) and the second source is
dropped (Key Decision 9, Schema Changes); (l) the ~18 private
`_transcribe_podcast_audio` test stubs are the real decomposition blocker and are
re-pointed onto the Deepgram port first (slice 7).

Third validation pass (2026-06-03, 6-agent re-verify against live code) confirmed
both reversed diagnoses and corrected four spec facts, now folded in: (m) the SSRF
"lift" is partial — `media._download_remote_file` (an earlier draft's `:747`
citation) **does not exist**; only the DNS/private-range/metadata guard
(`image_validation.validate_dns_resolution:209`) is a lift, while the streamed-abort
size cap is net-new (the existing `image_validation.fetch_with_redirect` buffers
then checks) — Problem #5, API Design, Risks updated; (n) Key Decision 9's reader
set is ~16 sites across four modules and includes two live-product readers
(`media.py:1135-1136` fragment JOIN, `media_document_map.py` chat doc-map), not just
the repair path — Key Decision 9, Schema Changes, slice 1 updated; (o) the
`active_transcript_version_id` negative gate is a slice-9 exit gate, not per-slice;
(p) `openai_{...}_v1` exists at `semantic_chunks.py:46` as the model name (the gate
must target the sha256 expression). Line-citation fixes: re-ingest import is
`media.py:65` (not `:85`); the `last_request_reason` CHECK is `models.py:3164-3169`;
the private test-stub count is 20 (16 `_transcribe_podcast_audio` + 4
`_enqueue_podcast_transcription_job`), not ~18. Also noted: YouTube `_mark_failed`
(`ingest_youtube_video.py:307`) runs with **no rollback** after the `IntegrityError`,
so today's failure can be a secondary "transaction is aborted" crash, messier than a
clean lost-transcript — strengthening the single-locked-writer fix.

## External References

- Podcast Index API (discovery / episodes / feed lookup):
  https://podcastindex-org.github.io/docs-api/
- Podcasting 2.0 namespace (`podcast:transcript`, `podcast:chapters`):
  https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md
- Podlove Simple Chapters:
  https://podlove.org/simple-chapters/
- OPML 2.0 (subscription import/export):
  http://opml.org/spec2.opml
- Deepgram pre-recorded transcription + diarization:
  https://developers.deepgram.com/docs/pre-recorded-audio
- OWASP SSRF Prevention Cheat Sheet (DNS-rebinding, IP allow/deny, redirects):
  https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html

Facts these references establish:

- A podcast's stable identity is the Podcast Index provider id; the RSS
  `feed_url` is mutable (feeds move hosts, add tracking params, get mirrored).
  Provider id is therefore the stronger identity key.
- Transcript and chapter artifacts are fetched from arbitrary feed-controlled
  URLs. SSRF defense (scheme allow-list, post-resolution private-range block,
  pin-to-resolved-IP against DNS rebinding, redirect re-validation, response
  size cap) belongs at the fetch boundary, not at each call site.
- Subscription sync is long-running per feed; fanning out one durable job per
  subscription is the correct shape for a poll, not a single in-process serial
  loop.

## Problem Statement

The podcast package (`python/nexus/services/podcasts/`) was partially
decomposed: helper modules `_writes.py` and `_normalize.py` were extracted and
some identity helpers were shared, but the extraction stopped before
consolidating the concerns that matter. The result is **multiple owners for the
same state, which have already diverged in behavior**, plus correctness hazards
that ride along on the duplication:

1. **Two podcast-identity resolvers, diverged.** `catalog.upsert_podcast`
   (`catalog.py:605`, provider-id-first) and `subscriptions._upsert_podcast_from_opml`
   (`subscriptions.py:626`, feed-url-first) are ~85% duplicated and resolve
   conflicts in opposite order. Subscribing the same feed via Discovery vs OPML
   can resolve to different rows or strand a podcast with an OPML-synthesized
   `provider_podcast_id` that blocks later enrichment.

2. **Three transcript-version writers, one unlocked.** The canonical
   `transcripts._create_next_transcript_version` (`transcripts.py:2068`) holds
   `pg_advisory_xact_lock(hashtext('podcast-transcript-version:{media_id}'))`
   around the `deactivate → MAX(version_no)+1 → INSERT` sequence. `sync.py`
   imports six private helpers from `transcripts.py` (`sync.py:65-72`) to reach
   it. `tasks/ingest_youtube_video.py:_create_transcript_version` (`~460-521`)
   is a *third*, locally re-implemented writer that takes **no** advisory lock.
   The database **already prevents the corruption** this might suggest:
   `podcast_transcript_versions` carries both `uq_podcast_transcript_versions_media_no`
   UNIQUE `(media_id, version_no)` (`models.py:2579`) and the partial
   `uix_podcast_transcript_versions_media_active` UNIQUE `(media_id) WHERE is_active`
   (`models.py:2594`), so no interleaving can commit a duplicate `version_no` or a
   second active row. The genuine defect is narrower and worse for UX: the unlocked
   YouTube writer *also* has no `IntegrityError` handling, and it can race
   **itself** (a transcription retry enqueued while the live worker still runs on
   the same `video` `media_id` — the earlier "safe because `podcast_episode` and
   `video` never share a `media_id`" reasoning is wrong; the collision is same-kind,
   same-row). The loser of the unique-index race throws, the violation propagates to
   the broad handler at `ingest_youtube_video.py:298`, and a transcript that
   actually succeeded is marked `E_TRANSCRIPTION_FAILED` and rolled back — lost
   work. (Worse still: `_mark_failed` at `:307` issues its UPDATE with **no prior
   rollback**, so against the already-aborted transaction it can itself raise
   "current transaction is aborted" — a secondary crash rather than a clean failure.)
   The single locked writer is still the right fix, but its job is to turn
   "one side 500s and loses its transcript" into clean serialization, and it must
   *also* translate `IntegrityError` to a typed retry as belt-and-suspenders. Under
   the repo's READ-COMMITTED default the lock is correct; data integrity, however,
   is owned by the two unique indexes, not by the lock.

3. **`library_entries` mutated outside its owner, with a diverged tie-break.**
   `subscriptions.unsubscribe_from_podcast` deletes from `library_entries`
   directly (`subscriptions.py:454`) and inlines a position-renormalization CTE
   ordered `position ASC, created_at ASC, id ASC` (`subscriptions.py:469`),
   while the canonical owner `libraries.normalize_library_entry_positions`
   orders `position ASC, created_at DESC, id DESC` (`libraries.py:1007`). Same
   logical operation, opposite ordering on ties → silent reordering after
   unsubscribe, and the libraries service's governance (admin + non-default
   guards) is bypassed. *(Post-cutover: that owner is now
   `library_entries.normalize_positions`; `libraries.py` was split and deleted.)*

4. **The scheduled poll runs full syncs inline/serially.** A durable per-
   subscription job (`podcast_sync_subscription_job`) exists and is used by
   manual refresh, but the scheduled poll runs every due subscription's full
   sync in-process and serially (`sync.py:282`). The lease numbers (queue job
   `300s`, poll-run `900s`, per-sub running `1800s`) are **not** a dead-letter trap
   as an earlier draft claimed: the worker heartbeat thread (`worker.py:559-587`)
   renews the 300s queue lease every 60s for the whole inline run, so a long-but-
   live poll is not dead-lettered. The real hazard is that the 900s poll-run and
   1800s per-sub leases are *staleness windows*, not deadlines — nothing kills an
   inline run that exceeds them. When one does, the next poll tick force-expires the
   still-`running` row (`sync.py:351-369`) and starts a **second concurrent
   poll/sync** over the same subscriptions, which duplicates the two non-idempotent
   writes: a second transcript version, and a second `enrich_metadata` enqueue
   (`_try_enqueue_metadata_enrichment` carries **no** dedupe key, `sync.py:1118`).
   The load-bearing fix is therefore idempotent enqueues (Key Decision 8), not
   merely renumbering leases. Enablement is gated in two places (schedule seconds
   **and** `WORKER_ALLOWED_JOB_KINDS`), so the poll is off today — the lowest-
   urgency correctness item, but one that must be fixed before the poll is ever
   enabled.

5. **Feed-controlled fetches are unevenly hardened.** The attacker-facing
   fetchers *do* pass URLs through `validate_requested_url` (`url_normalize.py:126`),
   which blocks bad schemes, userinfo, and *literal*
   private/loopback/link-local/metadata IPs — but it does **no DNS resolution**, so
   a hostname that resolves to a private IP (DNS rebinding) sails through. The repo
   *already* owns the missing DNS-resolving guard with per-hop revalidation and a
   metadata-IP block — `image_validation.validate_dns_resolution` (`:209`, blocks
   `169.254.169.254`) — which these call sites simply don't use; that part of the
   chokepoint is a straight lift. What the repo does **not** already own is a
   *streamed* size cap: the existing remote fetch
   (`image_validation.fetch_with_redirect`) buffers the whole body into
   `response.content` and checks the limit *after*, and the transcript fetcher's
   5 MB cap is likewise post-buffer (`rss_transcript_fetch.py:330`). The remaining
   concrete gaps: chapter-JSON and feed-page fetches have **no size cap at all**
   (`sync.py:2087`, `:1783`), and only the feed-page fetcher (`sync.py:1809-1833`)
   revalidates on redirect. The fix is to **lift** the DNS/private-range/metadata
   guard into one chokepoint and **add** the two capabilities the repo lacks — a
   streamed-abort size cap and pin-to-resolved-IP — not to re-derive the
   IP-classification logic.

6. **Untyped public surfaces.** Public functions across `catalog.py`,
   `subscriptions.py`, `sync.py`, and `transcripts.py` return `dict[str, Any]`,
   so callers cannot branch exhaustively and the type checker cannot help.

7. **God-files.** `transcripts.py` (2824 L), `sync.py` (2337 L), `catalog.py`
   (767 L) on the backend; `PodcastDetailPaneBody.tsx` (2025 L) on the frontend,
   which duplicates five subscription handlers with `PodcastsPaneBody.tsx`
   (764 L) — confirmed at `PodcastsPaneBody.tsx:264/291/340/378/414` vs
   `PodcastDetailPaneBody.tsx:225/612/638/664/698` — bypasses
   `useLibraryMembership`, runs a dual load path, and inlines a copy of the
   settings modal.

8. **Schema: a constraint that the new writer will violate, and an orphan table.**
   `ck_media_transcript_states_last_request_reason` (`models.py:3164-3169`) allows
   only `episode_open, search, highlight, quote, background_warming,
   operator_requeue`. Migration `0038` added `rss_feed` to the two sibling
   request-reason constraints (`ck_podcast_transcription_jobs_request_reason`,
   `ck_podcast_transcript_versions_request_reason` — both at `models.py:2503/2590`)
   but not this one. There is **no violation today**: the current RSS path passes
   `last_request_reason=None` deliberately (`sync.py:1096`). This cutover
   *introduces* the violation by having the unified writer record
   `last_request_reason='rss_feed'` for telemetry parity with the version row's
   `request_reason`, so the constraint widening is mandatory and must land in the
   same slice as the writer. The `podcast_transcript_chunks` table is orphaned
   (created in `0024`, backfilled in `0026`/`0027`, never read at runtime, not in
   the ORM; superseded by the unified `content_chunks` path).

9. **`embedding_config_hash` formula duplicated 4×** across
   `content_indexing.py` and the podcast pipeline, including
   `reconcile_stale_ingest_media.py:300`.

The professional fix is not to patch each bug at its call site — that papers
over the cracks the duplication created. It is to give each concern exactly one
owner with a typed contract, delete the duplicates, and let the bugs disappear
as a consequence.

## Governing Repo Rules

- `docs/rules/cleanliness.md` §6 (one concern, one owner; collapse modules that
  can mutate the same state to the canonical one), §8 (call only a module's
  public service — never its tables, private helpers, or SDK clients), §3
  (delete duplicate validators/normalizers), §5 (split god-files), §11/§13.
- `docs/rules/module-apis.md`: expose each capability in one primary form; do
  not expose interchangeable duplicate APIs; reuse an existing capability rather
  than introducing a near-duplicate.
- `docs/rules/layers.md`: services own their tables; no module reaches into
  another module's tables.
- `docs/rules/concurrency.md`: lock when concurrent calls could produce a result
  no sequential order could; the repo runs READ-COMMITTED by default and uses
  advisory locks (not `SELECT FOR UPDATE` layered on SERIALIZABLE) for this.
- `docs/rules/database.md`: explicit SELECT-then-write under the transaction
  discipline; no `ON CONFLICT` upserts, no rowcount-driven control flow, no
  `ON DELETE CASCADE` reliance; migrations are hand-written linear Alembic with
  non-reversible `downgrade()` for hard cutovers.
- `docs/rules/errors.md` / `docs/rules/correctness.md`: classify failures into
  typed error codes at the boundary; do not model classifiable absence as
  `dict[str, Any]` or `T | None`; validate at ingress and fail loudly.
- `docs/rules/control-flow.md`: branch exhaustively on finite value sets
  (`Literal` + `assert_never`).
- `docs/rules/keys-and-identities.md`: `*Id` is a private UUID; `*Ref` is a
  lower-layer/provider pointer — `provider_podcast_id` and `feed_url` are refs.
- `docs/rules/testing_standards.md`: real services; pin behavior with
  characterization tests before moving code; test control attaches to the
  `enqueue_job` boundary, never to private symbols.

## Goals

- One owner for podcast-row identity resolution, with a single, documented
  conflict-resolution policy.
- One owner for transcript-version writes, media-kind-agnostic, that always
  holds the advisory lock and runs in the caller's transaction.
- `library_entries` mutated only through the libraries service; one tie-break
  ordering in the codebase.
- The scheduled poll is a pure scheduler that enqueues one durable job per due
  subscription; sync executes only under a per-subscription job lease.
- One SSRF-safe fetch chokepoint for all feed-controlled URLs.
- Public functions in the package return frozen typed results with `Literal`
  status discriminants; zero `dict[str, Any]` public returns.
- God-files split into capability modules with small public surfaces; the two
  podcast panes share their subscription handlers and reuse `useLibraryMembership`.
- Schema corrected: `last_request_reason` CHECK includes `rss_feed`; the
  orphaned `podcast_transcript_chunks` table dropped.
- One source of truth for the active transcript version (`is_active`); the
  denormalized `media_transcript_states.active_transcript_version_id` pointer
  dropped (resolve active version by `WHERE is_active`).
- `docs/modules/podcast.md` and `docs/modules/player.md` written as the owned
  boundary docs (both are currently empty).

## Non-Goals

- Do not change the product behavior of discovery, OPML, episode listing,
  chapters, listening state, the playback queue, or the transcription quota/
  entitlement model. Behavior changes are limited to the documented correctness
  fixes (identity conflict resolution, unsubscribe ordering, transcript-version
  serialization, poll execution shape, SSRF rejection).
- Do not introduce a new provider, a new transcript source, or a second search
  lane. Podcast transcript chunks continue to flow into the existing
  `content_chunks` index.
- Do not add a compatibility export of `catalog.py` / `transcripts.py` symbols.
  Callers move to the new owners in the same slice the old symbol is deleted.
- Do not keep any private-symbol test seam. Tests that pinned behavior on
  `_create_next_transcript_version`, `_upsert_podcast_from_opml`, or the inline
  CTE move onto the public seam or the `enqueue_job` boundary.
- Do not turn the scheduled poll on as part of this cutover. Enablement remains
  an operator decision; this cutover only makes enablement a single coherent
  switch and fixes the lease shape.
- Do not migrate `podcast_transcript_chunks` data. It is dead; it is dropped.

## Current Owners To Reuse

- `python/nexus/services/library_entries.py` is the sole writer of
  `library_entries` (the former `libraries.py` god-file was split and deleted by
  the library-entries cutover): `add_podcast_to_library`,
  `remove_podcast_from_library` (calls the canonical normalizer),
  `normalize_positions` (ORDER BY `position ASC, created_at DESC, id DESC`),
  `set_subscription_libraries`, and `list_item_libraries` (the kind-parameterized
  function that replaced the former media/podcast twins). Governance guards
  (`require_admin` / `require_non_default`) live in
  `python/nexus/services/library_governance.py`.
- `python/nexus/services/content_indexing.py` owns chunking/embedding:
  `rebuild_transcript_content_index(db, *, media_id, transcript_version_id,
  transcript_segments, reason)` (`876`) → `rebuild_media_content_index(...,
  source_kind="transcript")` (`75`). It is the only place the
  `embedding_config_hash` formula should live.
- `python/nexus/jobs/registry.py` + `python/nexus/jobs/queue.py` own durable
  jobs and the periodic scheduler (`periodic_slot_start` / `periodic_dedupe_key`,
  `claim_next_job` with `FOR UPDATE SKIP LOCKED`). `podcast_sync_subscription_job`
  already exists; the poll must use it.
- `python/nexus/services/podcasts/provider.py` `PodcastIndexClient` is the model
  "vendor behind a port" — the Deepgram HTTP adapter should be refactored to the
  same shape (`deepgram_adapter.py`).
- `apps/web/src/lib/media/useLibraryMembership.ts` owns per-media library picker
  state (`loadLibraries` / `addToLibrary` / `removeFromLibrary` / `busy`).
- `apps/web/src/lib/api/useResource.ts` `useResource<T>` owns async resource
  loading (retry/abort/hydration). `apps/web/src/lib/useStringIdSet.ts` owns
  set-of-ids state. `PodcastSubscriptionSettingsModal.tsx` +
  `usePodcastSubscriptionSettingsModal.ts` own the settings modal.
- In-repo typed-result exemplars to copy: `agent_tools/inspect_resource.py`
  (frozen dataclass + `Literal` status discriminant), `media_document_map.py`
  (frozen records).

## Duplicate / Similar / Repetitive Patterns To Consolidate

### Podcast-row identity resolution

Current: `catalog.upsert_podcast` (provider-first) and
`subscriptions._upsert_podcast_from_opml` (feed-first); both delegate metadata
writes to `_writes.update_podcast_metadata` but hand-roll identity resolution.

Final state: one `upsert_podcast` is the sole resolver. `_upsert_podcast_from_opml`
and its caller path are deleted; OPML builds a `PodcastSubscribeRequest`
(synthesizing `provider_podcast_id` via `_stable_opml_provider_podcast_id` only
when no provider row exists) and calls `upsert_podcast`. **Resolution policy:
provider_podcast_id first, then feed_url** (key decision below).

### Transcript-version writes

Current: `transcripts._create_next_transcript_version` (locked) + five sibling
private helpers, reached by `sync.py` via private import; plus the unlocked local
copy in `ingest_youtube_video.py`.

Final state: one media-level `write_transcript_version(...)` owns the whole
sequence (lock → deactivate → allocate → insert version → insert segments → set
state → rebuild semantic index) and is called by podcast sync, on-demand
transcription, and YouTube ingest. The six private imports in `sync.py` and the
YouTube local writer are deleted. The advisory-lock key generalizes from
`podcast-transcript-version:{media_id}` to `transcript-version:{media_id}`.

### `library_entries` read + mutation

> **Ownership note (2026-06-03).** This concern is **owned by the lower-layer
> library-entries cutover**, `docs/cutovers/library-entries-ownership-hard-cutover.md`
> (its Slice 2). That spec creates `remove_user_podcast_subscription_libraries` +
> `_remove_podcast_from_library_in_txn` in the new `library_entries.py` module,
> deletes the divergent CTE, and removes the tie-break bug. **If the
> library-entries cutover lands first, this slice collapses to "route
> `subscriptions.unsubscribe_from_podcast` through the existing
> `library_entries.remove_user_podcast_subscription_libraries`" — no new SQL.**
> The shared contract both specs must match is
> `remove_user_podcast_subscription_libraries(db, *, viewer_id, podcast_id) ->
> PodcastLibraryRemovalResult`.
>
> **RECONCILED (post-cutover):** the library-entries cutover landed. Both
> `remove_user_podcast_subscription_libraries` and `_remove_podcast_from_library_in_txn`
> now live in `nexus.services.library_entries` (the lower-layer sole owner of
> `library_entries`), not in `libraries.py` (deleted). This slice reduces to routing
> `subscriptions.unsubscribe_from_podcast` through
> `library_entries.remove_user_podcast_subscription_libraries`. The code block below
> is retained for historical context; read the location as `library_entries.py`.

Current: `libraries.remove_podcast_from_library` (canonical) vs the inline
classification SELECT (`FOR UPDATE` over `library_entries`/`libraries`/`memberships`,
`subscriptions.py:402-448`) + DELETE + renormalization CTE
(`subscriptions.py:454-482`) in `subscriptions.unsubscribe_from_podcast`.

Final state: one libraries command `remove_user_podcast_subscription_libraries`
owns the whole multi-library teardown (classify → delete → renormalize → count)
and is the only code that reads or writes library tables for this flow; it reuses
the internal `_remove_podcast_from_library_in_txn` (also used by the public
single-library `remove_podcast_from_library`). The classification SELECT, the
DELETE, and the CTE in `subscriptions.py` are deleted — `subscriptions.py` touches
zero library tables. One tie-break ordering remains.

### Poll vs manual-refresh orchestration

Current: manual refresh enqueues `podcast_sync_subscription_job`; the scheduled
poll runs sync inline/serially.

Final state: both paths enqueue the per-subscription job. The poll only scans +
enqueues + records run telemetry, then completes. Leases become coherent.

### External feed-controlled fetches

Current: the feed-page fetcher is careful; chapter-JSON and transcript-sidecar
fetches are ad-hoc.

Final state: one `safe_get` chokepoint (scheme allow-list, post-DNS private-range
block, pin-to-resolved-IP, redirect re-validation, streamed size cap). Every
feed/chapter/transcript fetch routes through it.

### `embedding_config_hash` formula

Current: the formula
`hashlib.sha256(f"{embedding_provider}:{embedding_model}:{embedding_dimensions}:{CHUNKER_VERSION}").hexdigest()`
(`CHUNKER_VERSION = "block_token_v2"`, `content_indexing.py:32`) is written out
inline at four sites: `content_indexing.py:92-94` (canonical), `transcripts.py:73-75`
(`_semantic_index_requires_repair`) and `:1551-1553`
(`repair_podcast_transcript_semantic_index_now`), and
`reconcile_stale_ingest_media.py:300-302`.

Final state: one `compute_embedding_config_hash()` helper in `content_indexing.py`
(it already owns `CHUNKER_VERSION` and the canonical site); the other three sites
import it. A change to the separator, field order, or chunker version then touches
exactly one place instead of silently desynchronizing repair-vs-rebuild decisions.

### Trusted-provider retry-HTTP loop (`_get_json`)

Current: `provider.py::PodcastIndexClient._get_json` and `browse.py::_get_json`
are near-identical retry-with-backoff JSON GET loops (3 attempts, the same
retryable-status set `{408,429,500,502,503,504}`, `isinstance(payload, dict)`
assertion, `ApiError` on exhaustion). They differ only in backoff tuple, whether
`Retry-After` is honored (provider yes, browse no), and `trust_env`
(browse sets `False`, provider trusts ambient proxy/netrc).

Final state: one `get_json_with_retry(...)` helper (proposed
`services/net/http_retry.py`, sibling to `safe_fetch.py`) for **trusted first-party
provider APIs** — `trust_env=False`, optional `honor_retry_after`. `provider.py`
adopts it in this cutover (it is in the package). This helper is deliberately
**separate** from `safe_get`: provider APIs are first-party and need no SSRF guard;
feed-controlled URLs need SSRF and need no auth/Retry-After. Do not merge the two.
Migrating `browse.py` (outside the podcast subsystem) onto the shared helper is a
noted follow-up, **out of scope** here.

### `dict[str, Any]` public returns

Current: every public service function returns an untyped dict.

Final state: frozen dataclasses with `Literal` discriminants (see API Design).

### Frontend pane handlers

Current: `loadPodcastLibraries`, `handleAddPodcastToLibrary`,
`handleRemovePodcastFromLibrary`, `handleUnsubscribe`, `handleRefreshSync`
duplicated across `PodcastsPaneBody.tsx` and `PodcastDetailPaneBody.tsx`; the
detail pane re-implements episode-library state and runs a dual load path and an
inline settings modal.

Final state: one `usePodcastSubscriptionActions(podcastId)` hook wraps the five
handlers; episode-library state uses `useLibraryMembership`; one `useResource`
load path; the shared `PodcastSubscriptionSettingsModal` is reused.

## Target Architecture & Final State

### Backend module map (after)

```
python/nexus/services/transcripts/                 # NEW media-level owner (out of podcasts/)
  versions.py        write_transcript_version(...) — the single locked writer + state owner
  segments.py        TranscriptSegmentInput, normalization
  (admission/quota/execution stay podcast-scoped until/unless video needs them)

python/nexus/services/podcasts/
  provider.py        PodcastIndexClient (unchanged; the "vendor behind a port" model)
  identity.py        upsert_podcast, ensure_podcast, select_*_by_*, validate_and_normalize_feed_url,
                     is_podcast_identity_conflict   (sole identity owner; absorbs _writes upsert)
  discovery.py       discover_podcasts
  episodes.py        list_podcast_episodes_for_viewer + episode option sets + show-notes cap
  subscriptions.py   subscribe/unsubscribe/settings/status + OPML import/export
                     (calls identity.upsert_podcast and libraries.* — owns no library_entries SQL)
  subscriptions_query.py  list_subscriptions, get_podcast_detail_for_viewer + sort/filter option sets
  feed.py            RSS fetch + pagination + XML parse (chapters/transcripts/show-notes) via safe_get
  ingest.py          _sync_subscription_ingest — episode/media upsert, chapter upsert, calls
                     transcripts.write_transcript_version for RSS transcripts
  poll.py            run_scheduled_active_subscription_poll (scan + enqueue only),
                     enqueue_podcast_subscription_sync, run_podcast_subscription_sync_now
  transcription.py   request/forecast/batch admission, quota reservation, run_now (Deepgram),
                     repair — calls transcripts.write_transcript_version
  deepgram_adapter.py  Deepgram HTTP behind a port (mirrors provider.py)

python/nexus/services/net/
  safe_fetch.py      safe_get(url, *, max_bytes, timeout_s, allow_content_types) — SSRF chokepoint
                     for feed-controlled URLs (resolve+pin+revalidate+size-cap)
  http_retry.py      get_json_with_retry(...) — trusted first-party provider GET
                     (PodcastIndex now; browse follow-up). NO SSRF guard (first-party).
```

`catalog.py`, `sync.py`, and the monolithic `transcripts.py` are deleted (their
contents move to the modules above). No re-export shim remains.

### Frontend module map (after)

```
apps/web/src/app/(authenticated)/podcasts/
  usePodcastSubscriptionActions.ts   # NEW: the 5 shared handlers, typed once
  PodcastsPaneBody.tsx               # uses the hook; no local handler copies
  [podcastId]/
    PodcastDetailPaneBody.tsx        # shell: useResource only, the hook, the shared modal
    PodcastEpisodeList.tsx           # NEW: episode rows + filters + pagination
    PodcastEpisodeRow.tsx            # NEW: per-episode actions; useLibraryMembership(media_id)
    useEpisodeTranscriptController.ts # NEW: extracted transcript request/forecast/poll machine
```

## Capability Contracts / API Design

All new Python results are `@dataclass(frozen=True)`; all status fields are
`Literal`. `TranscriptRequestReason` and the state literals are shared type
aliases.

### Transcript versioning (media-level, single writer)

```python
# python/nexus/services/transcripts/segments.py
@dataclass(frozen=True)
class TranscriptSegmentInput:        # owned by segments.py; imported by versions.py
    segment_idx: int
    t_start_ms: int
    t_end_ms: int
    canonical_text: str
    speaker_label: str | None

# python/nexus/services/transcripts/versions.py

TranscriptRequestReason = Literal[
    "episode_open", "search", "highlight", "quote",
    "background_warming", "operator_requeue", "rss_feed",
]
TranscriptCoverage = Literal["partial", "full"]
SemanticStatus = Literal["none", "pending", "ready", "failed"]
FragmentStrategy = Literal["preserve_anchors", "replace"]

@dataclass(frozen=True)
class TranscriptWriteResult:
    media_id: UUID
    transcript_version_id: UUID
    version_no: int
    transcript_coverage: TranscriptCoverage
    segment_count: int
    semantic_status: SemanticStatus

def write_transcript_version(
    db: Session,
    *,
    media_id: UUID,
    created_by_user_id: UUID | None,
    request_reason: TranscriptRequestReason,
    transcript_coverage: TranscriptCoverage,
    segments: Sequence[TranscriptSegmentInput],
    fragment_strategy: FragmentStrategy = "preserve_anchors",
    rebuild_semantic_index: bool = True,
    now: datetime,
) -> TranscriptWriteResult:
    """Sole owner of transcript-version creation and the media transcript-state
    transition. Runs in the CALLER's transaction (transaction() is non-reentrant).
    Holds pg_advisory_xact_lock('transcript-version:{media_id}') for the WHOLE
    sequence and owns every table it touches:

        1. lock          pg_advisory_xact_lock('transcript-version:{media_id}')
        2. deactivate    UPDATE podcast_transcript_versions SET is_active=false
        3. allocate      version_no = MAX(version_no)+1 ; INSERT the version row
        4. fragments     disposition per `fragment_strategy` (below)
        5. insert        insert_transcript_fragments(new segments)
        6. segments      INSERT podcast_transcript_segments
        7. media         UPDATE media SET processing_status='ready_for_reading'
        8. state         INSERT/UPDATE media_transcript_states
                         (last_request_reason = request_reason — needs the 0129 CHECK widen;
                         does NOT write active_transcript_version_id — that column is dropped,
                         active version resolves by WHERE is_active, see Key Decision 9)
        9. semantic      rebuild_transcript_content_index(...) when rebuild_semantic_index;
                         on failure the transcript stays usable and semantic_status
                         becomes 'failed' (podcast_reindex_semantic job retries).

    `fragment_strategy` resolves the ONE real divergence between today's three
    writers (the reason the YouTube copy exists — verified: idx-bump at
    sync.py:1016 / transcripts.py:1404 vs DELETE at ingest_youtube_video.py:148/158):
      - "preserve_anchors" — bump prior fragments aside
        (UPDATE fragments SET idx = idx + 1_000_000) and KEEP them, so existing
        highlight anchors survive re-transcription. Pinned by
        test_retranscription_creates_new_version_without_deleting_old_highlight_anchor.
      - "replace" — hard reset: DELETE the media's highlights then its fragments
        before inserting. Destructive; only YouTube ingest uses it today
        (see Key Decision 7 — whether video re-ingest SHOULD keep nuking highlights
        is an explicit open decision, carried not silently inherited).

    media-kind agnostic: podcast_episode and video both call this; the lock key is
    kind-agnostic 'transcript-version:{media_id}' (Key Decision 2; deploy-window risk)."""
```

Callers after cutover: `podcasts/ingest.py` (reason `"rss_feed"`,
`fragment_strategy="preserve_anchors"`), `podcasts/transcription.py::run_now`
(reason from the request, `"preserve_anchors"`), and
`tasks/ingest_youtube_video.py` (reason `"episode_open"`,
`fragment_strategy="replace"` pending Key Decision 7). The six private imports in
`sync.py` and the local YouTube writer are deleted.

### Podcast identity (single resolver, provider-first)

```python
# python/nexus/services/podcasts/identity.py

@dataclass(frozen=True)
class PodcastUpsertResult:
    podcast_id: UUID
    created: bool
    matched_on: Literal["provider_id", "feed_url", "none"]
    feed_url_conflict: bool      # provider matched row A but feed_url belongs to row B
    provider_id_conflict: bool   # feed matched row A but provider_id belongs to row B

def upsert_podcast(
    db: Session,
    body: PodcastSubscribeRequest | PodcastEnsureRequest,
    *,
    now: datetime,
) -> PodcastUpsertResult:
    """Sole resolve-or-create for a podcast row. Resolution precedence:
    1) provider_podcast_id, 2) normalized feed_url. On conflict (provider id and
    feed_url point at different rows) provider id wins: return the provider-
    matched row and DO NOT move the other row's feed_url. Conflicts are recorded
    on the result for telemetry, never silently 'fixed'."""
```

### Libraries reuse (txn-agnostic inner helper)

```python
# python/nexus/services/library_entries.py  (sole library_entries owner — READS and writes)

@dataclass(frozen=True)
class PodcastLibraryRemovalResult:
    removed_from_library_count: int
    retained_shared_library_count: int

def remove_user_podcast_subscription_libraries(
    db: Session, *, viewer_id: UUID, podcast_id: UUID
) -> PodcastLibraryRemovalResult:
    """Sole owner of unsubscribe library teardown. Classifies the viewer's
    library_entries for this podcast (admin-owned non-default -> removable;
    foreign-owned shared -> retained + counted — the logic currently inline at
    subscriptions.py:402-448), deletes the removable entries, renormalizes each
    affected library via normalize_library_entry_positions, and returns the
    counts. Runs in the CALLER's transaction (no inner commit, transaction() is
    non-reentrant). subscriptions.py calls ONLY this and touches ZERO library
    tables — read or write."""

def _remove_podcast_from_library_in_txn(
    db: Session, *, library_id: UUID, podcast_id: UUID
) -> None:
    """Internal building block: delete the (library_id, podcast_id) entry and call
    normalize_library_entry_positions(db, library_id). No commit. Used by the
    public remove_podcast_from_library and by the teardown command above."""

def require_can_remove_podcast_from_library(
    db: Session, viewer_id: UUID, library_id: UUID
) -> None:
    """Single governance guard: admin role + non-default library."""
```

`subscriptions.unsubscribe_from_podcast` calls
`remove_user_podcast_subscription_libraries(db, viewer_id=..., podcast_id=...)`
inside its existing transaction and maps the result onto `PodcastUnsubscribeOut`
(`removed_from_library_count` / `retained_shared_library_count`). The inline
`FOR UPDATE` classification SELECT, the DELETE, and the renormalization CTE
(`subscriptions.py:402-482`) are all deleted — **the classification read moves
too**, not only the writes. The negative gate (below) therefore bans every
`library_entries` reference under `services/podcasts/`, not just mutations.

### SSRF-safe fetch chokepoint

```python
# python/nexus/services/net/safe_fetch.py

@dataclass(frozen=True)
class SafeFetchResult:
    final_url: str
    content_type: str
    text: str

def safe_get(
    url: str,
    *,
    max_bytes: int,
    timeout_s: float,
    allow_content_types: frozenset[str],
) -> SafeFetchResult:
    """Single egress for feed-controlled URLs. Enforces: https/http scheme
    allow-list; resolve DNS then reject loopback/private/link-local/ULA ranges;
    pin the connection to the resolved public IP (DNS-rebinding defense); reject
    redirects to a non-revalidated host; stream and abort past max_bytes;
    content-type allow-list. Raises typed E_SOURCE_* on violation."""
```

Built by **lifting** the part the repo already owns — the DNS-resolve +
private-range reject + metadata-IP block in `image_validation.validate_dns_resolution`
(`:209`) and the per-hop redirect-revalidation loop in the feed-page fetcher
(`sync.py:1809-1833`) — into one neutral `services/net/` chokepoint, and **adding the
two capabilities the repo does not have today**: pin-to-resolved-IP (TOCTOU/DNS-
rebinding defense) and a *streamed* size cap that aborts mid-read. The streamed cap
is genuinely new — the existing image fetch (`image_validation.fetch_with_redirect`)
buffers the full body then checks the limit, so there is no streamed-abort to lift.
It is a partial lift, not a green-field build and not a pure copy. Used by `feed.py`
for the three feed-controlled text fetches, each with its own `allow_content_types`:

- feed pages: `application/rss+xml`, `application/atom+xml`, `application/xml`,
  `text/xml` (and lenient `text/html` fallback the current parser already tolerates);
- Podcasting 2.0 chapter JSON: `application/json`, `application/json+chapters`;
- transcript sidecars: `text/vtt`, `application/x-subrip`, `text/plain`,
  `application/json`.

`safe_get` covers only fetches **our backend performs**. The episode audio file
is **not** fetched by us — its URL is handed to Deepgram, which fetches it — so it
is out of `safe_get`'s scope (a malformed/internal audio URL simply fails at
Deepgram, not an SSRF vector against our network). `max_bytes` caps each fetch
(feeds/chapters currently have no cap — a DoS gap this closes); the streamed read
aborts past the cap rather than buffering the whole body.

### Poll = scheduler only

`run_scheduled_active_subscription_poll` scans due active subscriptions and calls
`enqueue_podcast_subscription_sync` per subscription (the manual-refresh path),
records `podcast_subscription_poll_runs` telemetry, and returns. It performs no
feed I/O and no transcript writes. The per-subscription job lease covers one
sync; the poll-run lease only needs to cover scan+enqueue.

## Key Decisions

1. **provider_podcast_id wins identity conflicts.** (User decision.) The
   provider id is the stable catalog identity; `feed_url` is a mutable ref.
   When they disagree, return the provider-matched row and leave the other row's
   feed untouched, recording the conflict on `PodcastUpsertResult`. Documented in
   `docs/modules/podcast.md`.

2. **Transcript versioning is a media-level concern, lifted out of `podcasts/`.**
   Videos already use these tables; filing the writer under `podcasts/` is what
   produced the unlocked YouTube co-owner. One owner, one lock, kind-agnostic key.

3. **The poll enqueues; it does not execute.** Unifies orchestration with manual
   refresh, fixes the lease mismatch, and makes per-sync failure isolation and
   retry the job system's responsibility (where it belongs).

4. **SSRF defense is a boundary, not a checklist.** One chokepoint with
   pin-to-resolved-IP; no per-call-site hardening that the next call site forgets.

5. **Typed results everywhere public.** `dict[str, Any]` is treated as a defect
   per `errors.md`/`correctness.md`; frozen dataclasses with `Literal`
   discriminants replace them, copying in-repo exemplars.

6. **Hard cutover, single slice per concern.** The old symbol and its last caller
   move in the same change; negative `rg` gates prove the duplicate is gone.

7. **Open decision — does video re-ingest keep destroying highlights?** Unifying
   the writer surfaces an inconsistency the duplication hid: podcast
   re-transcription preserves highlight anchors (idx-bump), while YouTube re-ingest
   `DELETE`s highlights + fragments (`ingest_youtube_video.py:148/158`). The cutover
   carries this faithfully via `fragment_strategy="replace"` so it is **not a
   silent behavior change**. Whether `"replace"` is correct for video — or whether
   video should also preserve anchors like podcasts — is a product decision to make
   explicitly during slice 1, not to inherit by accident. Default recommendation:
   keep `"replace"` for video this cutover; file a follow-up if anchors should
   survive video re-ingest.

8. **Poll enqueue is idempotent by the sync claim, deduped by a unique key.** When
   the poll and a manual refresh can both enqueue `podcast_sync_subscription_job`
   for the same subscription, duplicates are harmless at execution
   (`_claim_subscription_sync_pending` lets exactly one transition
   `pending->running`), but they pile up rows. The poll enqueues with
   `enqueue_unique_job` keyed `podcast-sync:{subscription_id}` (the repo's existing
   dedupe primitive, used by the periodic scheduler) so a due subscription with an
   already-pending job is not re-enqueued. The poll-run singleton
   (`podcast_subscription_poll_runs` partial unique index) is retained for run
   telemetry/coherence but is no longer load-bearing for correctness now that the
   poll does no inline work. Separately, the ingest path's
   `_try_enqueue_metadata_enrichment` (`sync.py:1118`) also enqueues with **no**
   dedupe key, so a re-ingest (or the concurrent-poll window in Problem #4) doubles
   the enrichment job; it adopts the same `enqueue_unique_job` pattern keyed
   `enrich-metadata:{media_id}` in the poll slice.

9. **Collapse the two sources of truth for "the active version."** The active
   transcript version is stored twice today: the `is_active` boolean on
   `podcast_transcript_versions` (the partial unique index makes "at most one" a DB
   invariant) and the denormalized pointer
   `media_transcript_states.active_transcript_version_id` — and **nothing ties the
   pointer to the `is_active` row**, so they can drift (a `SET NULL` on version
   delete nulls the pointer while `is_active` rows survive). Rather than carefully
   keeping both in sync inside `write_transcript_version`, make the divergence
   unrepresentable: drop the pointer column and resolve the active version by
   `WHERE is_active` (one indexed lookup — covered by the partial unique index
   `uix_podcast_transcript_versions_media_active`). This is the make-illegal-states-
   unrepresentable move; for a single-user prototype it is strictly cheaper than
   maintaining two writers of the same fact. **Blast radius (validated reader
   sweep — wider than "the repair path"):** the pointer is read at ~16 sites across
   four modules, including two that serve *live product reads*, not just
   maintenance — `media.py:1135-1136` joins fragments to the active version
   (`f.transcript_version_id = mts.active_transcript_version_id`) to render reader
   content, and `media_document_map.py:177/220/332/386` (`_active_transcript_version_id()`)
   feeds the chat document map — alongside the semantic-repair path
   (`transcripts.py`, `reconcile_stale_ingest_media.py:310/334`) and
   `content_indexing.py:1026`. Slice 1's writer stops setting the pointer and
   **every one of those reads** switches to a `WHERE is_active` join; this is a
   substantial sub-project, not a one-line change. Slice 9 drops the column and
   rebuilds the dependent partial index (see Schema Changes).

## How It Composes With Other Systems

- **content_indexing**: `write_transcript_version` calls
  `rebuild_transcript_content_index` (`source_kind="transcript"`). Podcast and
  video transcript chunks land in the same `content_chunks` table as web/EPUB/PDF
  fragments. No second lane is introduced.
- **search / retrieval**: unchanged. The keyword/typeahead lane excludes
  `podcast_episode`/`video` from chunk search; the chat/evidence RAG retrieval
  uses `content_chunks` including transcript chunks (exercised by
  `e2e/tests/real-media/podcast-episode.spec.ts`). This cutover keeps both lanes.
- **libraries**: the only `library_entries` writer. Podcast subscribe/unsubscribe
  and OPML routing call its public functions; the subscription↔library join
  (`podcast_subscription_libraries`) stays owned by `set_subscription_libraries`.
- **jobs/queue + scheduler**: the poll enqueues `podcast_sync_subscription_job`;
  per-sub sync runs under a job lease; `podcast_reindex_semantic_job` retries
  failed semantic indexing; transcription stays on `podcast_transcribe_episode_job`.
- **billing / quota**: transcription admission (`request_*`, quota reservation,
  entitlements `can_transcribe`) is unchanged; only the *write* step it ends in
  is consolidated.
- **playback queue**: `auto_queue` enqueue on sync is unchanged; episodes still
  resolve `external_audio` playback and seed the global player.
- **frontend panes**: both panes consume `usePodcastSubscriptionActions` and the
  shared settings modal; episode rows use `useLibraryMembership`.

## Schema Changes (single non-reversible migration, next free revision 0129)

Head is `0128_oracle_plate_storage_key_contract`; this migration is `0129_*`.

- Drop + recreate `ck_media_transcript_states_last_request_reason` to include
  `'rss_feed'` (Postgres CHECK constraints are not `ALTER`-able in place) and
  mirror the change in `models.py:3164-3169`. **Mandatory**: slice 1's unified
  writer sets `last_request_reason='rss_feed'` on RSS sync, which the current
  constraint rejects (today the path passes `None` at `sync.py:1096`). The two
  sibling constraints already allow it (`models.py:2503/2590`); this aligns the
  third.
- `DROP TABLE podcast_transcript_chunks` — verified orphaned: not in the ORM,
  zero runtime/test references; lifecycle is create `0024` → backfill `0026`/`0027`
  only. No `ON DELETE CASCADE` to unwind (per `database.md`); confirm no FK points
  *at* it before dropping.
- `DROP COLUMN media_transcript_states.active_transcript_version_id` (Key Decision
  9) and rebuild the `ix_media_transcript_states_semantic_repair` partial index,
  which currently filters on `active_transcript_version_id IS NOT NULL` — re-express
  it against `semantic_status` (or the `is_active` version join). This lands in
  slice 9 (schema hygiene), **after** slice 1 has switched every active-version
  read/write to `WHERE is_active` — the "stop using, then drop" order `database.md`
  requires. The negative gate `active_transcript_version_id` must return zero
  matches before this migration runs — note this is therefore a **slice-9 exit
  gate**, not a per-slice gate (the column and its model mapping legitimately exist
  from slice 1 through slice 9). The complete reader set to migrate first (validated
  sweep): `media.py:1135-1136` (fragment-serving JOIN),
  `media_document_map.py:177/220/332/386` (`_active_transcript_version_id()`, chat
  doc-map), the semantic-repair path (`transcripts.py` admission/repair,
  `reconcile_stale_ingest_media.py:310/334`), and `content_indexing.py:1026` — plus
  the writer's own state-set (step 8).
- `downgrade()` raises `NotImplementedError` (hard cutover, per `database.md`).
- Audit sibling enum-add migrations: confirm no other CHECK constraint was left
  un-updated when an enum value was added (the `0038` `last_request_reason`
  omission is a pattern, not an instance).

## Scope

In scope:

- The `python/nexus/services/podcasts/` package; the new
  `python/nexus/services/transcripts/` and `python/nexus/services/net/` modules.
- `tasks/ingest_youtube_video.py` (transcript-write co-owner), `tasks/podcast_*`.
- `library_entries.py` (txn-agnostic inner helper; shared guards now in
  `library_governance.py`) — `libraries.py` was split and deleted by the
  library-entries cutover.
- `content_indexing.py` (single `embedding_config_hash` helper) and the three
  other call sites.
- The two podcast panes, `usePodcastSubscriptionActions`, episode subcomponents.
- One schema migration; `models.py` constraint mirror.
- `docs/modules/podcast.md`, `docs/modules/player.md`, and `docs/architecture.md`
  §8.8 where contracts change.

Out of scope:

- Discovery/OPML/episode/chapter/listening/queue product behavior.
- Transcription quota/entitlement model.
- Adding/removing providers or transcript sources.
- Turning on the scheduled poll.
- Any change to `content_chunks` schema or the search lanes.

## Files

Delete: `services/podcasts/catalog.py`, `services/podcasts/sync.py`,
`services/podcasts/transcripts.py` (contents relocated);
`tasks/ingest_youtube_video.py::_create_transcript_version` +
`_insert_transcript_segments` + `_upsert_media_transcript_state` (the three local
copies); `subscriptions.py::_upsert_podcast_from_opml` + the inline
`library_entries` classification SELECT/DELETE/CTE.

Also delete (dead/hollow, found during validation — fold into slice 7):
the three `Environment.TEST` enqueue seams (`transcripts.py:907/948/1010`, return
`True` to fake enqueue success in tests — replaced by controlling the real
`enqueue_job` boundary); the discarded `request_id` param (`sync.py:523-525`,
`_ = request_id`); `_get_usage_snapshot` (`transcripts.py:2206-2228`, never
called); the hollow passthrough wrappers `_rebuild_transcript_content_index_for_version`
(`transcripts.py:2189-2203`) and `mark_podcast_transcription_failure_for_recovery`
(`transcripts.py:1089-1108`, one-line wrapper over the private impl).

Create: `services/transcripts/versions.py`, `services/transcripts/segments.py`,
`services/net/safe_fetch.py`, `services/net/http_retry.py`,
`services/podcasts/{identity,discovery,episodes,
subscriptions_query,feed,ingest,poll,transcription,deepgram_adapter}.py`,
`apps/web/.../podcasts/usePodcastSubscriptionActions.ts`,
`.../[podcastId]/{PodcastEpisodeList,PodcastEpisodeRow}.tsx`,
`.../[podcastId]/useEpisodeTranscriptController.ts`, the migration,
`docs/modules/podcast.md`, `docs/modules/player.md`.

Edit: `services/library_entries.py` (was `services/libraries.py`, now deleted),
`services/content_indexing.py`,
`services/media.py` (its `from nexus.services.podcasts.transcripts import
requeue_podcast_transcription_for_source_refresh` at `media.py:65` repoints to the
new owner — see cycle note below), `tasks/reconcile_stale_ingest_media.py`,
`tasks/ingest_youtube_video.py`, `tasks/podcast_reindex_semantic.py`,
`tasks/podcast_active_subscription_poll.py` + `tasks/podcast_sync_subscription.py`
(task entrypoints stay stable; only their target module moves),
`api/routes/podcasts.py`, `api/routes/media.py` (import sites),
`jobs/registry.py` (poll handler), `db/models.py`,
`apps/web/.../podcasts/PodcastsPaneBody.tsx`,
`.../[podcastId]/PodcastDetailPaneBody.tsx`.

**Cycle note.** `media.py:65` imports re-ingest from the podcast transcript module
today; `catalog.py:591` lazily imports `media` to dodge the resulting
`media ⇄ podcasts` cycle. Lifting transcript versioning into a top-level
`services/transcripts/` package is the lever that *breaks* this cycle: put the
re-ingest entrypoint (`requeue_*`) on a leaf that both `media` and the podcast
package import top-level. Invariant after cutover: `transcripts/` imports
`content_indexing` (one direction); `media` and `podcasts/*` import `transcripts/`;
nothing imports back. The lazy in-function import at `catalog.py:591` is then
deleted, not relocated.

## Slice Plan (correctness first; each slice lands green with its negative gate)

Pin characterization tests **before** moving code (see below). Then:

0. **Migration `0129` first.** Drop+recreate the `last_request_reason` CHECK to
   include `rss_feed` (mirror `models.py:3164-3169`). Deploy this *before* slice 1
   so the writer's `rss_feed` write never hits a live violation. (The
   `podcast_transcript_chunks` DROP is independent — defer to slice 9.)
1. **Transcript-version single writer.** Create `transcripts/versions.py::
   write_transcript_version` (with `fragment_strategy`, the internal advisory lock,
   and `IntegrityError`→typed-retry translation); migrate `sync.py`,
   `transcription.py`, and YouTube ingest to it in this slice; delete the six
   private imports and the three YouTube local copies. Switch every active-version
   read/write to `WHERE is_active` and stop writing `active_transcript_version_id`
   (Key Decision 9 — this is the wide part of the slice: the full reader set is
   `media.py:1135-1136`, `media_document_map.py:177/220/332/386`, the semantic-repair
   path, and `content_indexing.py:1026`, not just the writer; the column itself is
   dropped later in slice 9). Make Key Decision 7 (video `"replace"` vs
   `"preserve_anchors"`) explicitly here. Closes bug #2.
2. **Library-entry ownership.** *Owned by the library-entries cutover
   (`docs/cutovers/library-entries-ownership-hard-cutover.md`, Slice 2) — see the
   ownership note in "`library_entries` read + mutation" above.* If that cutover
   has landed, this slice is just: route `subscriptions.unsubscribe_from_podcast`
   through `library_entries.remove_user_podcast_subscription_libraries` (no new
   SQL). If not, add `remove_user_podcast_subscription_libraries` (+ the internal
   helper/guard) to `libraries.py`, route unsubscribe through it, and delete the
   inline classification SELECT, DELETE, and CTE from `subscriptions.py`. Either
   way closes bug #3 (both the write ownership and the read).
3. **Podcast identity single resolver.** Land `identity.upsert_podcast` with the
   provider-first policy and `PodcastUpsertResult`; route OPML through it; delete
   `_upsert_podcast_from_opml`. Closes bug #1.
4. **SSRF chokepoint + trusted-provider retry helper.** Land `net/safe_fetch.py`
   by *lifting* the DNS-resolve/private-range/metadata-IP core from
   `image_validation.validate_dns_resolution` (see API Design), add the
   streamed-abort size cap and pin-to-resolved-IP (the two net-new capabilities),
   and route feed/chapter/transcript fetches through it; land
   `net/http_retry.py` and move `provider.py::_get_json` onto it. Also add the
   characterization test that exercises the audio-URL validation
   (`transcripts.py:2580`), which the universal transcription stub leaves dead
   today. Closes bug #5 and the provider retry-loop duplication.
5. **Poll = scheduler.** Rewrite the poll to enqueue per-sub jobs via
   `enqueue_unique_job` (Key Decision 8); reconcile leases. Closes bug #4.
6. **`embedding_config_hash` single helper.** Add `compute_embedding_config_hash`
   in `content_indexing.py`; repoint the three other sites. Closes bug #9.
7. **Decompose god-files + typed results + dead-code sweep.** *First step, before
   moving any code:* introduce the `deepgram_adapter.py::DeepgramClient` port and
   re-point the 20 integration-test stubs that monkeypatch the private
   `_transcribe_podcast_audio` (16 sites) and reassign
   `_enqueue_podcast_transcription_job` (4 sites,
   `test_podcasts.py:524,554,567,622,3169…8734`) onto the public port and the
   `enqueue_job` boundary — otherwise relocating `transcripts.py` breaks all of
   them at once. Then split `catalog`/`sync`/`transcripts` into the module map;
   convert public returns to dataclasses; delete the `Environment.TEST` enqueue
   seams, the discarded `request_id`, `_get_usage_snapshot`, and the two hollow
   wrappers. Closes bugs #6/#7 and the dead-code findings.
8. **Frontend consolidation.** `usePodcastSubscriptionActions`,
   `useLibraryMembership` for episodes, single `useResource` path, shared modal,
   pane decomposition. Closes the frontend half of #7.
9. **Schema hygiene + docs.** Drop `podcast_transcript_chunks`; write
   `docs/modules/podcast.md` + `docs/modules/player.md`.

## Characterization Tests To Pin First

Before any code moves, lock current behavior so intended changes are visible:

- **Version-write race**: two concurrent `write` calls on one `media_id` produce
  contiguous `version_no` and exactly one `is_active` — *and neither call returns a
  spurious `E_TRANSCRIPTION_FAILED` or loses a committed transcript*. The DB unique
  indexes already guarantee the no-duplicate/one-active half on every path; what
  fails today is the YouTube path, which turns the lost unique-index race into a
  rolled-back transcript (pin that as fail-then-fix).
- **Fragment strategy preservation** (pin before the writers merge): an RSS/podcast
  re-transcribe (`fragment_strategy="preserve_anchors"`) keeps existing highlight
  anchors; a YouTube re-ingest (`"replace"`) clears them. This locks the one real
  behavioral divergence the unified writer must carry, not flatten.
- **Unsubscribe position contiguity & ordering**: positions are `0..n-1` with no
  gaps and a single deterministic ordering after unsubscribe (pins the tie-break
  change).
- **Upsert equivalence**: subscribing a feed via Discovery and importing the same
  feed via OPML resolve to the *same* `podcast_id` under the provider-first
  policy (pins the divergence fix).
- **SSRF rejection**: `safe_get` rejects loopback/private-range hosts, oversize
  responses, and cross-host redirects.

Move test control off private symbols onto the `enqueue_job` boundary and the
public seams.

## Acceptance Criteria

Behavioral:

- Discovery-subscribe and OPML-import of the same feed yield one `podcast_id`.
- Concurrent transcript writes on one media never duplicate `version_no` or leave
  two `is_active` rows; the YouTube path is covered by the same test.
- Unsubscribe leaves library positions contiguous and ordered identically to
  `list_library_entries`; default-library and admin guards are enforced.
- The scheduled poll completes within its run lease regardless of subscription
  count; each sync runs under its own job lease and fails/retries independently.
- `safe_get` rejects SSRF inputs with typed errors; all feed-controlled fetches
  use it.

Negative `rg` gates (must return zero matches — each is a CI check, a review aid
that backs the behavioral tests, not a substitute for them):

- `pg_advisory_xact_lock` anywhere except `services/transcripts/versions.py`.
- `def _create_transcript_version` / `def _create_next_transcript_version` /
  `def _insert_transcript_segments` / `def _upsert_media_transcript_state` outside
  the single owner; and `from .transcripts import _` (the six private imports) in
  `services/podcasts/`.
- `library_entries` (the bare table name) and ORM `LibraryEntry` **anywhere** under
  `services/podcasts/` — reads included, since the classification SELECT moves too.
- `_upsert_podcast_from_opml`.
- the inline hash expression
  `sha256(f"{embedding_provider}:{embedding_model}:` anywhere except
  `compute_embedding_config_hash` in `content_indexing.py`. *(Gate on this sha256
  expression, not on `openai_{...}_v1`: that string DOES exist — at
  `semantic_chunks.py:46`, as the embedding-model **name**, not the config hash — so
  a gate on it would miss the four hash duplicates and false-match an unrelated
  site.)*
- raw `httpx.` GET/stream for feed/chapter/transcript outside
  `services/net/safe_fetch.py` (and the provider/browse trusted-API loop outside
  `services/net/http_retry.py`).
- `run_podcast_subscription_sync_now(` called from the poll body (the poll calls
  only `enqueue_podcast_subscription_sync`); `transcript_state` / feed-fetch
  symbols referenced inside `poll.py`.
- `-> dict[str, Any]` on any public (non-`_`) function in the package.
- `Environment.TEST` anywhere under `services/podcasts/` and `services/transcripts/`
  and in `tasks/ingest_youtube_video.py` (the enqueue test seams are gone).
- `idx + 1000000` / `DELETE FROM fragments` / `DELETE FROM highlights` anywhere
  except `services/transcripts/versions.py` (fragment disposition has one owner).
- `active_transcript_version_id` anywhere in the codebase (the column is dropped;
  the active version is resolved by `WHERE is_active`).
- duplicated handler definitions across the two podcast panes (each of the five
  handler names defined at most once, in `usePodcastSubscriptionActions.ts`); any
  second settings-modal JSX in `PodcastDetailPaneBody.tsx`.

Schema:

- `ck_media_transcript_states_last_request_reason` accepts `rss_feed`;
  `podcast_transcript_chunks` no longer exists; `make test-migrations` green.

Docs:

- `docs/modules/podcast.md` and `docs/modules/player.md` are non-empty and
  describe the owners, the identity policy, and the transcript-write seam.

## Test Plan / Gates

- `make check` (static) + `make test-back-unit` + `make test-front-unit` +
  `make test-front-browser` per slice.
- `make test-back-integration` for identity/unsubscribe/poll/transcript slices.
- `make test-migrations` for the schema slice.
- End gate: `make test-real-media` + `make test-live-providers` (real Podcast
  Index + Deepgram + the `podcast-episode` transcript-search e2e).

## Risks & Mitigations

- **`transaction()` is non-reentrant (commits on exit).** Mitigated by the
  txn-agnostic inner helpers (`_remove_podcast_from_library_in_txn`,
  `write_transcript_version` running in the caller txn); no nested
  `transaction()` calls.
- **`safe_get`'s two new capabilities carry the SSRF risk, not the lift.**
  Pin-to-resolved-IP needs custom httpx transport/SNI handling, and the streamed-
  abort size cap is net-new (the existing fetchers buffer then check). Only the
  DNS/private-range/metadata classification is a straight lift from
  `image_validation`. Mitigated by building both against the SSRF characterization
  tests (private-range host, oversize body, cross-host redirect) before any
  feed/chapter/transcript call site is migrated onto the chokepoint.
- **Turning the poll into a scheduler** changes failure semantics (per-sub
  isolation). This is the goal; the lease reconciliation and the per-sub job
  retry policy are validated in the poll slice's integration tests.
- **Behavior change in identity conflict resolution** could re-point an existing
  OPML-created row. Mitigated by the upsert-equivalence characterization test and
  by recording (not silently fixing) conflicts on `PodcastUpsertResult`.

- **Advisory-lock key rename opens a brief deploy window.** Generalizing the key
  from `podcast-transcript-version:{media_id}` to `transcript-version:{media_id}`
  means old and new worker processes that coexist during a rollout take *different*
  advisory locks and do not mutually exclude. The exposure is tiny (two version
  writes for the *same* `media_id` from two code generations within the rollout
  window), but it is real. Mitigation: this is a worker-only path, so drain/replace
  workers rather than rolling them, or accept the window given the rarity — and
  land the key rename in the same slice (1) as the single-writer consolidation so
  there is never a *third* key in flight. The characterization race test runs
  post-deploy on a single generation.

- **`fragment_strategy="replace"` is destructive.** A wrong call site (e.g. an RSS
  resync passing `"replace"`) would delete user highlights. Mitigated by the
  default being `"preserve_anchors"`, by `"replace"` appearing at exactly one call
  site (YouTube ingest), and by the `DELETE FROM highlights` negative gate pinning
  it inside the single writer.

- **Migration is non-reversible and load-bearing for slice 1.** The `0129` CHECK
  widen must be applied before (or atomically with) the slice-1 deploy, because the
  unified writer immediately writes `last_request_reason='rss_feed'`. Deploy order:
  migration first, then the writer. The `DROP TABLE` is independent and can ride
  slice 9.

- **Dropping `active_transcript_version_id` needs a complete reader audit.** The
  column feeds the `ix_media_transcript_states_semantic_repair` partial index and is
  read by the semantic-repair path; missing a reader would silently break "which
  version is active." Mitigated by the order — slice 1 switches all reads/writes to
  `WHERE is_active` while the column still exists, and the slice-9 `DROP COLUMN` runs
  only once the `active_transcript_version_id` negative gate is green — and by
  rebuilding the dependent index in the same migration.
