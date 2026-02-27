# pr-05: pdf quote-to-chat compatibility

## goal
Extend quote-to-chat/context rendering to support PDF highlights and annotations using persisted PDF quote-match metadata, with deterministic degrade-safe behavior.

## builds on
- pr-03 (pdf readiness, `pdf_readiness.py`)
- pr-04 (pdf highlight APIs, `pdf_quote_match.py`, `pdf_quote_match_policy.py`, write-time match metadata persistence)

## acceptance
- quote-to-chat for PDF highlights uses stored `exact` as the authoritative quote text. never re-extracts from the document at quote time.
- nearby context (prefix/suffix) is included only when the match status is deterministic `unique`. ambiguous, no-match, and empty-exact cases omit nearby context but still succeed (quote text only).
- `pending` match metadata attempts in-memory enrichment at quote time, then degrades safely if enrichment fails. no hidden persistence/backfill during quote rendering — quote path is read-only.
- when `pdf_quote_text_ready(media)` is false, return `E_MEDIA_NOT_READY` — do not silently drop the context.
- for streaming: quote-blocking errors (like `E_MEDIA_NOT_READY`) must surface before LLM token streaming starts. no partial stream then error.
- existing HTML/EPUB/transcript quote-to-chat behavior remains unchanged.
- visibility and masked-existence semantics stay aligned with S3/S4 expectations.
- reuse existing shared modules (`highlight_kernel`, `pdf_quote_match`, `pdf_quote_match_policy`, `pdf_readiness`) — do not fork or duplicate matching/policy logic.

## key decisions
- **streaming error timing**: quote-context rendering completes before provider streaming begins. a quote-blocking failure can follow `meta` but emits no `delta` events before terminal `done` error.
- **coherence validation**: persisted match metadata offsets are advisory — validate coherence before trusting them for nearby context. incoherent metadata degrades safely rather than using bad offsets.

## non-goals
- no frontend PDF viewer/highlight UI.
- no changes to PDF geometry persistence or write-time match behavior (pr-04 owns that).
- no new enrichment/backfill persistence paths (read-only quote rendering only).
