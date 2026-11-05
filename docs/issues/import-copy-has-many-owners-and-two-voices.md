# import copy ownership still overstates its scope

origin: 2026-11-01 import survey at `61562d1`
status: carried open with the obsolete capitalization claim narrowed

at `aed29154`, `apps/web/src/lib/imports/copy.ts:2` still claims every import string, while `docs/modules/imports.md:5` also gives line wording to `lineView.ts`. the same browser-capture failure sentences are repeated in `copy.ts:455` and `components/imports/ImportInspector.tsx:254`.

the failure catalog is now lowercase; the old 44/54 census and deleted add-session references are historical, not current defects. `docs/modules/visual-system.md:179` and `:473` deliberately distinguish lowercase feedback from sentence-case application actions.

impact: duplicated wording and an inaccurate ownership contract invite drift. resolve by stating the actual copy boundary and making repeated explanations use their existing semantic owner. preserve the category rules and the line presenter's distinct job; this does not require one file for every label or a new abstraction. no new runtime copy census was run.
