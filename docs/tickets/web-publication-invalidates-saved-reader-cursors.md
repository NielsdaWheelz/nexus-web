# web publication invalidates saved reader cursors

- status: open
- area: reader publication / consumption
- priority: p2
- origin: 2026-09-15 restoration rehearsal, main `f75a7aa0d77a`

Web refresh (`web_article_ingest.py:231`) and browser recapture
(`media_source_ingest.py:3427`) replace fragments without reconciling saved reader
positions. `reader_publication.py:222` advances generation without cursor repair;
`reader_cursor.py:82` loads schema-valid stale references. New writes are
validated, but `DocumentReaderSession.ts:86` cannot select the deleted fragment.

The populated clone audit found one such cursor among 206 web media. Its saved
zero-offset quotation includes removed page chrome and has no match in the
current article. Production still held the stale reference at 07:24:06 utc.
Migration 0228 correctly refuses to invent its destination. The user was asked
to open the current article and scroll, saving a deliberate current position.
Private evidence is under `/tmp/nexus-release-255` and the corresponding devbox
operator directory; no database row was manually changed.

Reconcile positions through the cursor owner within publication's transaction.
Preserve only independently exact targets. Expose explicit recovery when the
old passage is absent or ambiguous; never silently clear progress or substitute
a proportional position. The general reset-progress action also clears
engagement and completion override, so it is not an equivalent cursor repair.

Acceptance: unchanged content retains its exact position across replacement;
changed content never fabricates a match; unresolved positions permit deliberate
recovery. Concurrent writes retain revision correctness. Recovery preserves
engagement and completion history. Use deterministic owner regressions and a
manual publication/reader check within the existing test contract.

## current-item recovery

on 2026-09-15 the user chose reset progress for “this living hand”. a read-only
production check at 13:31:02 utc confirmed an empty cursor at revision 3; the
published fragment and canonical-text hash were unchanged. the prepared narrow
operator reset was never executed. this resolves the current migration input,
while the publication defect remains open. the fresh db0215 archive captured at
13:32:06–13:33:28 utc includes the deliberate user recovery.
