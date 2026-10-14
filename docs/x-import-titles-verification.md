# x title verification

2026-10-14; isolated branch `codex/x-import-titles`. initial source base
`b6768bee2469cbc3a43902302836a44d07a11ea7`, integrated with upstream
`fa62a6901`, then `f30a844a5`; migration `0277→0278`.
temporary checks follow the approved red/green/refactor/deletion sequence;
the permanent gate remains `./scripts/test`.

## observed

| boundary | result |
|---|---|
| source and admission | authored excerpts, full notes/alt text, one-hop graph, explicit enumeration, identity reuse without naming, atomic child obligations, lost claims, deletion and four authorization/rollback refusals passed on postgres |
| retained reading | pending/failed/unavailable/resource-limited/dead source work keeps its saved copy; exact dead-job repair and first-import failure passed |
| saved cursor | 12 real-db cases passed: all viewers, unicode/start/end, unique full/window matches, ambiguous/missing rejection, save/reset interleavings and no activity effects |
| title publication | 12 real-db cases passed: null restoration, unchanged stamp, source/title staleness, revoked access, lost claim, missing context, private evidence and byte limits; four real-worker preflight refusals opened zero generations |
| live content | eleven synthetic captured-source cases passed with stock codex 0.160.0, `gpt-6-luna`/`low`, one generation each and zero tools; 252 output tokens total. stance, abstention, sarcasm, spanish/cjk, truncated capture, late long-form qualification and nested-quote injection passed meaning review |
| actual x | post `20` imported over authenticated http, fetched from x, published by the normal background child under its 448-mib limit, then named by the native interactive worker; authenticated detail/reader passed. separate live image-post acquisition retained its absence of alt text |
| product | 15 copy/planner cases and eight actual callback cases passed; authenticated chrome 155 flow passed eight cases with zero page errors. canonical/quote selection, exact dom nodes and viewport survived title completion; completed lost-response refresh replay reused the receipt; naming failure still exposed refreshed content |
| migration | populated actual alembic upgrade passed six groups: historical bibliography outcomes, reviews/replay/usage, raw sql-null/json-null/object preservation, malformed outcomes, active work and open-generation refusals |
| cutover operator | frozen-target replay, stale/access refusal, legacy saved-copy initialization and inline child accounting passed; the qualified terminal manifest had zero unfinished/unaccounted obligations, retaining title failures explicitly |
| non-x | controlled ordinary task completion and no-findings/review/replay passed with real queue, scalar and contributor writes. live local document/resource reads succeeded; funded brave research remains blocked below |
| receipt recovery | escaping provider error, actual task cancellation, sigkill/dead-letter/next-attempt interruption, preserved terminal calls and late callback refusal passed |

source, metadata and reader owners reviewed each other's publication boundaries.
an independent session reviewed attribution, lock order, migration, capability
parity and operator accounting. a second peer review confirmed each resolution.
browser runtime checks passed again at `830c1eca` after the first rebase. the
subsequent `f30a844a5` integration preserves both lectern placement receipts and
pending source refresh receipts; its shared-action composition was peer-reviewed.

the independent review's five concrete findings received targeted red/green checks:
no repeated primary thread bodies; actual baseline photo/video canonical text and
terminal cursors conserved (including newly appended context); mixed-script/long
token excerpts; exact parent-completed census child accounting with two negative
provenance cases; mounted lost-202 confirmation after the notice expires while queued.
the last case passed real-db/menu/browser checks without relaxing fresh admission.

## limits and costs

the owner explicitly accepted [blocked bibliography live qualification](tickets/brave-search-payment-required.md):
both configured brave keys return http 402. no successful four-tool bibliography
claim is made. browser faults and accepted outputs were controlled external
boundaries; actual model quality was qualified separately.

source evidence duplicates captured text. one-hop/no-vision evidence and the byte
limit can leave source labels. null reruns restore them. exact cursor matching can
refuse edits; the saved copy remains. source changes add a sequential cursor read;
title admission adds one detail read. worker recovery may repeat inference.
reader text retains attachment source links; downloaded copies retain their
download-time labels because titles do not change content identity.

cross-navigation intent persistence, mutable embedded-child labels, non-x cursor
replacement and the preexisting queue/tool lock inversion remain separate tickets.
the reader fixes do not claim those broader contracts.
legitimate missing media-expansion behavior is an [unverified provider question](tickets/x-media-expansion-absence-unqualified.md),
not an observed capture defect; strict incomplete-response failure remains visible.

production release `134f4f4c3` aligned api/worker/web and upgraded `0277→0278`.
the controller retained a verified 1,270,557,222-byte r2 backup, sha256
`263bb620f1c3d205b46db5ba31e6ce20e18b24efda0ac605adf83a4f14fddf2a`.
verification read back the remote archive and traversed it with `pg_restore`;
it did not execute a database restore. 208 historical metadata jobs validated
after migration, including 72 raw sql-null dead results. no pre-migration
byte-for-byte hash baseline was obtained.

the first frozen census settled 54 targets: 52 refreshed, two saved-position
refusals, nine additional child titles; zero unfinished/unaccounted obligations.
this established accounting, not acceptance. production content review found an
implicit 30-day archive range, five mistranslated titles and one literal `null`
title. corrective publication/reacquisition remains required before handoff.
one position becomes exactly mappable after historical acquisition; the other
crosses an inline-quotation/embed boundary and is the owner's explicit
[preserved-copy exception](tickets/x-inline-quote-refresh-loses-saved-position.md).

the narrow archive correction passed two provider-boundary red/green checks and
detached real acquisition of the recoverable saved position. nine real-db language
input checks and nine ordinary native naming calls qualified the title correction:
seven faithful titles, one preserved invalid-output rejection, then one actual
json-null completion after explicit json instructions. no tools; 220 output tokens.
these local checks do not certify the currently published production captures.
see [the release item](tickets/x-title-production-cutover.md).

sanitized receipts are retained outside the repository at
`/private/tmp/nexus-x-titles-proof-20261014/`. sanitized receipt/review/screenshot files are retained. temporary tests, proof
credentials, isolated containers, volumes and setup were deleted after final green;
shared account state and standard development dependencies were preserved. no
runtime test seam or harness remains. `./scripts/test` passed after deletion and
`f30a844a5` integration (exit 0, canonical head `0278`); its receipt is
`static-post-deletion.log` in that directory.
