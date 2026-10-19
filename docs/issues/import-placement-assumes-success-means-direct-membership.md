# import placement projects direct membership from a no-content response

status: open · origin: 2026-10-14 library picker design audit · area: web / imports, library placement

problem: a successful add does not establish that a direct membership exists, but imports present it as confirmed direct membership.

evidence: `apps/web/src/components/nexus/useAddContentSession.ts:983-995` replaces the selected destination's relation with direct after an acknowledged add, via `apps/web/src/lib/libraries/libraryPlacement.ts:90-101`. backend `python/nexus/services/library_entries.py:824-827` intentionally skips direct insertion when the parent podcast occupies that library; canonical inventory reports inherited at `:628-630`.

reproduce: add the parent podcast to the destination after the import editor's eligibility read and before its episode add. the add succeeds without a direct entry, while the editor projects direct/removable state. this is a source-derived race; no live concurrent mutation performed.

prerequisites: preserve server ownership of direct/inherited relation and availability.

fix: obtain authoritative relation after the write, or return it from the existing domain command. local desired membership may be shown as pending, but cannot manufacture a confirmed relation.

acceptance: the parent-podcast race renders inherited, nonremovable membership after reconciliation; ordinary direct add remains responsive and correct.
