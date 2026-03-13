# podcast-transcript-phase3-4

## summary
- shipped dedicated transcript state + coverage tracking (`media_transcript_states`) and immutable transcript version artifacts (`podcast_transcript_versions`, `podcast_transcript_segments`, `podcast_transcript_chunks`) with active-version projection
- hardened async lifecycle behavior: stale `running` transcription jobs are reclaimable by workers using a lease cutoff aligned with ingest stale thresholds
- fixed highlight offset updates so transcript anchors remain offset-consistent after highlight span edits
- corrected search semantics so metadata title search includes transcript-unavailable podcast/video media while semantic transcript chunk search remains readiness-gated
- made migration rollback safer by unlinking transcript version metadata from fragments (instead of deleting fragments) and removing only rows incompatible with pre-0009 highlight constraints during deep downgrade
- aligned docs/readmes with the explicit transcript admission endpoint, transcript chunk search type, migration inventory, and implementation status

## decisions
- **kept `fragments(media_id, idx)` uniqueness** rather than introducing version-scoped fragment idx uniqueness because EPUB and existing FK shape depend on current semantics; historical transcript rows are preserved via idx shifting on re-transcription
- **used ingest stale threshold for transcription job lease reclaim** to avoid two divergent stale-job clocks across ingest and transcript execution paths
- **separated metadata search from transcript readiness gating**: media discovery/search by title remains available even when transcript extraction is unavailable, while transcript content search stays strictly state-gated
- **kept deterministic local semantic scoring** (hash embedding + lexical overlap) for this phase to avoid adding pgvector infra before correctness contracts settle
- **downgrade compatibility over strict data retention when crossing pre-typed-highlight schema**: retain transcript fragments/highlights where possible, but allow removal of rows that cannot satisfy historical not-null fragment-offset constraints

## how to test
```bash
# migration round-trip
make test-migrations-no-services

# targeted backend regression suites
cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test NEXUS_ENV=test SUPABASE_JWKS_URL=http://127.0.0.1:54321/auth/v1/.well-known/jwks.json SUPABASE_ISSUER=http://127.0.0.1:54321/auth/v1 SUPABASE_AUDIENCES=authenticated uv run pytest -v tests/test_podcasts.py tests/test_search.py tests/test_capabilities.py

# static + build checks
make lint-back lint-front typecheck build verify-celery-contract
```

## risks
- semantic transcript ranking still uses deterministic lightweight vectors, not pgvector ANN; relevance quality and recall/latency at larger scale remain bounded
- deep downgrade past typed-highlight migrations necessarily drops rows that violate legacy fragment-offset not-null constraints
- transcript fragment idx preservation can create sparse idx space after repeated re-transcription cycles
- scheduled stale-job reconciliation is still best-effort; we now reclaim stale `running` claims at worker claim-time but not via a dedicated periodic sweeper yet
