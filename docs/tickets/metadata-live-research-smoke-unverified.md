# metadata live research remains unverified

status: open
origin: 2026-09-14 original-publication-date implementation; updated 2026-09-17
area: metadata verification

the original implementation checked date acceptance/publication with a controlled
codex peer. it did not inspect the live model's historical judgments or actual
external query contents. local inspection on 2026-09-14 found no brave search
key or configured/default codex host socket. the removed tests do not establish
that live behavior.

2026-10-01 update: read-only production inspection found all eight lewis
re-enrichment jobs from 15:12 utc dead: five uncertain dispatches and three
catalog-refresh failures. no metadata publication or recorded web-tool call
occurred for these jobs. they establish execution failure, not poor historical
judgment. see `model-cutover-dead-media-generations.md` and
`metadata-production-catalog-refresh-fails.md`. current checkout also changes
the scoped mcp path to codex shell, so qualify the actual released route after
repair; the old run cannot qualify the new one.

2026-10-02 candidate: local domain/api/worker/browser checks pass with controlled
external leaves; [receipt](../metadata-enrichment-verification.md). actual
research judgments, external query contents and the untrusted-passage journey
remain NOT_RUN. qualified native integration is recorded separately in
`metadata-native-kernel-integration.md`.

prerequisite: a configured metadata runtime and brave search, using public
sample documents and an explicit small cost ceiling. inspect a few original /
edition resolutions and actual query contents, including an untrusted passage,
through ordinary ingestion/retry. no benchmark framework or library rewrite is
needed.

acceptance: record the runtime revision, sample inputs, dates, observed web
requests, and failures. do not describe scope enforcement as query-content
confidentiality or claim general historical accuracy from this manual check.
