# four deletions are each gated on one production select

status: open (production verification blocked) · origin: 2026-09-17 slop sweep (claude session)
· area: schema and wire vocabularies · oi-143

four verified dead-vocabulary deletions are blocked only because this worktree
cannot read production. each is pure code deletion if its count is zero.

2026-09-17 cleanup verification: the documented batch-mode operator connection
`ssh nexus@5.78.194.235` failed with `connect to host 5.78.194.235 port 22:
Operation timed out` (exit 255) before any remote command or sql ran.
the second batch-mode attempt in this session also timed out before execution
(`/tmp/nexus-cleanup.3vgYE2/production-cleanup-counts-retry.log`, exit 255).
all production counts, controller release pointer, extension version and the planned literal
`avg(vector)` capability check remain `NOT_RUN`. local pgvector fixtures do not
satisfy this prerequisite. retry the read-only snapshot when connectivity returns;
record the deployed revision and audit its writers before deleting vocabulary.

public api and web `/version` reads succeeded in the same session. both reported
source `7965f7cd88865dac03be672c2164ef58235840fd`; the api reported expected
database revision `0230`. that is deployment identity evidence, not a query of
the actual database revision, stored rows, or vector aggregate capability.

1. retired dossier failure codes (ART-04 / WLR-03).
   `SELECT count(*) FROM artifact_build_events WHERE event_type =
   'HistoricalFailed'` and `SELECT count(*) FROM artifact_build_failures WHERE
   failure_code IN ('EntitlementDenied','BudgetExceeded','ProviderRefused',
   'ProviderIncomplete')`. the only producer is
   `migrations/alembic/versions/0224_codex_personal_generation.py:952`
   (`_tag_historical_failures`); `services/artifacts/engine.py:3435-3438` refuses to emit the event
   type post-cutover. commit 0977dfe3e1 moved the four codes out of
   `DossierBuildFailureCode` into `HistoricalDossierBuildFailureCode`, so rows
   carrying them were written between 0198 and 0224 and 0224 does not delete
   them all.
2. system-role chat messages (CHAT-03). `SELECT count(*) FROM messages WHERE
   role = 'system'`. all four DB `Message(...)` constructions
   (`chat_run_candidates.py:176,201`, `chat_run_message_prep.py:65,88`) write
   user or assistant; every `role="system"` in python is a prompt turn, never a
   row. the count matters because `decodeConversationMessage`
   (`messageWire.ts:325-335`) spreads the raw object without validating `role`,
   so a legacy row would reach a narrowed union unchecked.
3. superseded source attempts (ING-07). `SELECT count(*) FROM
   media_source_attempts WHERE status = 'superseded'` — already filed as
   `docs/tickets/media-source-attempt-superseded-status-has-no-writer.md`
   (oi-021); this sweep confirms the no-writer finding and adds one site the
   ticket misses, `services/agent_tools/web_page_read.py:313-316`.
4. pgvector version (ATLAS-PY-FALLBACK). `SELECT extversion FROM pg_extension
   WHERE extname = 'vector'`. `services/atlas_projection.py:83-120` catches
   `ProgrammingError`, string-matches the driver message for `avg(vector)`,
   rolls back and recomputes mean embeddings in python. production postgres is
   an operator-pinned image digest (`deploy/hetzner/docker-compose.yml:9-21`),
   not supabase-hosted, so the repo cannot prove the installed version;
   `avg(vector)` shipped in pgvector 0.5.0.

prerequisite: run the four queries against production, or have the owner run
them and report which are zero.

fix: for 1, if both counts are zero delete `HistoricalDossierBuildFailureCode`,
`HistoricalFailedEventPayload`, the `HistoricalFailed` event member, the
`ReadDossierBuildFailureCode` / `ReadFailedEventPayload` /
`WritableArtifactBuildEventType` aliases, `_FAILURE_CODE_READ_ADAPTER`, the
`decodeHistoricalDossierBuildFailureCode` decoder and the four retired copy
cases, and narrow `ck_artifact_build_events_type` in a new migration; if non-zero, rewrite or delete
the rows first. for 2, delete `SystemMessage.tsx`, its `MessageRow` arm, the
`roleLabel` `case "system"` at `conversationFind.ts:150-158`, `.systemBody`
(`MessageRow.module.css:92`), and narrow `ConversationMessage.role`
(`types.ts:300`). for 3, follow the existing ticket's first arm and also drop
the `web_page_read.py` branch. for 4, delete `_fetch_mean_embeddings_python`
(91-120), the try/except/rollback wrapper (83-90), the `ProgrammingError`
import and the `atlas_avg_vector_unavailable_fallback_python` log.

acceptance: each vocabulary admits only values a writer produces, and the atlas
mean-embedding path has one implementation. delete oi-021's ticket with item 3.
