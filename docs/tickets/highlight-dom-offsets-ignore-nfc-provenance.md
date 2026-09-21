# highlight dom offsets ignore nfc provenance

status: open · origin: 2026-09-21 reader cleanup audit, base `93563d12b` · area: browser highlights

`lib/highlights/domTextCursor.ts:265` builds nfc-normalized canonical text and
exact dom provenance, but `selectionToOffsets.ts:317`, `applySegments.ts:302`,
`lib/sharing/publicHighlightRendering.ts:59`, and
`components/reader/useAnchoredReaderProjection.ts:158` instead recompute offsets
through whitespace-only helpers in `lib/highlights/canonicalText.ts`.
all paths are under `apps/web/src/`.

reproduction: render `e\u0301clair xyz` in one text node. its canonical text is
`éclair xyz`. selecting raw utf16 `[8,11)` (`xyz`) maps to canonical `[8,10)`
(`yz`); painting canonical `[7,10)` (`xyz`) decorates raw `[7,10)` (` xy`).
canonical-text equality validation passes, so the wrong quote can be saved.
confirmed in chromium through a temporary bundle of the current production
entrypoints: selection returned `yz`; hosted and public painters returned
` xy`; existing provenance range projection returned `xyz`. ascii and astral
controls passed. session receipt: `/tmp/nexus-highlight-audit/before.png`.

prerequisites: none. make the cursor's existing provenance the sole owner of
dom/canonical mapping in selection, decoration, public shares, and margin
projection. reuse the range projection currently duplicated by reader find
and conversation find; remove whitespace-only offset conversion and its
`trimLeadCp` metadata after all consumers move.

acceptance: browser selection and both painters agree on exact canonical
ranges for decomposed and cross-node nfc text, astral text, whitespace runs,
inline markup, and overlapping highlights; canonical text remains unchanged
after decoration; `./scripts/test` passes.
