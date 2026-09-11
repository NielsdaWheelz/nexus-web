# `run_media_content_reindex(embed_texts=...)` is a seam only the index proof uses

**Status:** open (decision recorded: accepted until a loopback embedding peer exists)
**Origin:** Imports workspace cutover, Track B review, 2026-09-08
**Area:** `python/nexus/tasks/media_content_reindex.py`,
`python/tests/service/test_import_index_recovery.py`

## What is wrong

`media_content_reindex_job` is a one-line wrapper over
`run_media_content_reindex(payload, context, embed_texts)`; production always
passes `build_text_embeddings`, and the only other caller is the index recovery
proof, which passes a deterministic local function. cleanliness.md asks that
production seams kept only for tests be removed, and testing-standards §6 wants
deterministic provider behaviour served from a test-owned process behind the
configured HTTP client.

## Decision

Kept for now. The controller materializes the embeddings peer only for journey
runtimes, so a service proof cannot make `build_text_embeddings` succeed; without
the seam "a dead reindex job repairs and the real worker restores `ready`" would
be journey-only evidence. The seam mirrors the shape
`build_spooled_content_index_plan(embed_texts=...)` already has, and the proof
still crosses the real claim, fences, and publication.

## Proposed fix

Serve deterministic embeddings from a controller-owned loopback provider for
service runtimes, point the proof's worker at the unchanged
`media_content_reindex_job`, and inline `run_media_content_reindex` back into it.

## Acceptance

`media_content_reindex_job` is the only entry point, the index recovery proof
still runs the real worker end to end, and no product module takes an
`embed_texts` parameter for a test's sake.
