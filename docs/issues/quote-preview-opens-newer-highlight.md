# quote preview can open a newer highlight

status: open; source audit at `d6b73c712b205c614512545c9f88c7a2fde717f7`, 2026-10-19; no browser execution.

the former shift-click defect was fixed by `ff7528774` (`unify resource references and source navigation`): `apps/web/src/components/chat/QuotedPassage.tsx:64-65` now uses the shared resource row and link adapter. its original exact-preview acceptance exposed a separate remaining inconsistency.

problem: composer preview text is loaded by highlight identity without version-based refresh (`QuotedPassage.tsx:24-32`), while `python/nexus/services/chat/quotes.py:95-100` substitutes live-highlight activation. after that highlight changes, clicking the displayed old preview can open the new extent. sent quotes instead use the saved `reader_quote` target (`quotes.py:89-94`).

fix: make preview text and its navigation target name the same revision, or refresh/invalidate the preview when that revision changes. preserve sent snapshots and existing send revision checks.

resolved when: load a composer quote, edit its highlight elsewhere, then ordinary/shift-open it; the displayed words and revealed extent agree, or the stale preview is explicitly invalidated. sent quotes still reveal their frozen extent.
