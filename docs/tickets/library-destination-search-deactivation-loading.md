# destination search deactivation retains initial loading

status: deferred, source-only; visible impact unqualified.
origin: 2026-10-05 independent source review at `031c3c95de81f25306b4e17fd656d9eeaf72218c`.
area: library destination search.

`apps/web/src/components/libraries/useLibraryDestinationSearch.ts:77–81` advances generation and clears only continuation loading before returning when inactive. initial loading stays true; its invalidated settlement cannot clear it at line92. `LibraryDestinationPicker.tsx:93` activates with `open && enabled`, while line216 keeps an open surface rendered when enablement changes. this permits retained pending state without an active request; no mounted failure is claimed.

prerequisite: qualify the real mounted picker while enabled becomes false during a held initial search. the bounded search owner must settle deactivation's pending state while retaining the raw draft and installed rows.

acceptance: deactivate a held initial search with the picker open; no orphan pending indicator remains, late settlement publishes nothing, draft/rows survive, and reopening starts the current query normally. no library product change belongs to the podcast success slice.
