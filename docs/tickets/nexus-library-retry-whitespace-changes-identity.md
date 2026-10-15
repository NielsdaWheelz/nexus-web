# whitespace-only edits change library retry identity

status: open
origin: 2026-10-14 libraries-pane design review; checkout `367da80e0c1beb1c426f6d2d72201b0733809b50`
area: web / nexus library creation replay

`apps/web/src/components/nexus/useNexusController.ts:295` trims a submitted name,
but :496-505 replaces its library id after a retryable failure when the raw
input changes. adding a trailing space therefore gets a new id and then submits
the same normalized name. backend replay matches the supplied id and normalized
name (`python/nexus/services/library_governance.py:164-228`). a committed request
whose response was lost can be followed by a second library with the same name;
names are not unique (`python/nexus/db/models.py:455-484`). the index form already
compares trimmed names before choosing its id
(`apps/web/src/app/(authenticated)/libraries/LibrariesPaneBody.tsx:164-170`).
source inspection only; no production mutation performed.

prerequisite: none. tie the retry identity to the normalized command payload,
retaining the submitted id across whitespace-only edits and repeated attempts.

acceptance: simulate a committed request with a lost response; add/remove edge
whitespace and retry. the id is unchanged and exactly one library exists.
