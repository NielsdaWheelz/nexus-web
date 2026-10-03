# configured embedding credential rejected during metadata research

status: open; metadata qualification unblocked, local configuration repair pending
origin: 2026-10-02 metadata acceptance, consumer `dd38c4c9`
area: local embedding configuration

the configured local embedding key is rejected with http 401
`invalid_api_key`. `CredentialRejected` escapes
`semantic_chunks.py` → `search/service.py` → `tool_runtime/handlers.py` during
`nexus.document.search`; the submitted native turn has no authoritative seal.
actual job `d8ffbb88-63ee-4ae4-b794-e35ed26114e9`, generation
`474d8103-5243-5eb1-8a35-0a80f1e8b592`, remains uncertain and unpublished.
original sanitized receipt:
`/private/tmp/nexus-metadata-acceptance-ezuwcb8_/metadata-live-second-uncertain.receipt.json`,
sha256 `1a9aba4a330546650683a137f762cf62571bbcdccb55b29df4757b399f2c1c6b`.
original database `metadata_live_research_invalid_embedding` and its private
backup remain preserved. temporary proof sources were deleted after qualification.

the rejected value is in `/Users/nnandal/Documents/code/nexus-web/.env`,
`OPENAI_API_KEY`. that file predates the failed run and remains unchanged;
its value differs from the qualified private backend source
`deploy/env/env-prod-backend`. the latter passes the existing real embedding
primitive with model `openai_text_embedding_3_small_256_v1` / 256 dimensions.
fresh metadata jobs using that source publish successfully; original job and
backup remain uncertain. no credential value is retained in this ticket.

known missing configuration is already blocked before admission. key presence
does not establish remote validity. the pinned provider explicitly classifies
`CredentialRejected` as an operator `RuntimeDefect`; document search does not
declare credential rejection as a normal tool result. converting it to empty
search or `ResourceUnavailable` would violate those contracts.

the local configuration owner must replace/remove the rejected root-env value
or explicitly bind local startup to its intended valid credential source.
preserve the original journal and uncertainty without redispatch; add no fallback,
native recovery or periodic product health probe.

acceptance: ordinary local startup uses its intended valid embedding credential;
actual embeddings/search succeed, and the original uncertain job remains blocked.
