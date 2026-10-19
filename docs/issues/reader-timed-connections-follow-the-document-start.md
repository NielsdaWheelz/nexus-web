# reader timed connections follow the document start

source baseline: `69c00182c8328f46cec893517971f87f03cdbf16`; still present at `origin/main` `ff57128842b470510446b3edca54922ebcace41e` on 2026-10-16. line numbers refer to the original baseline unless stated otherwise.

status: open
origin: 2026-10-16 resource presentation and navigation audit
area: reader / connections following

resolved audio, video and transcript passage groups are assigned document
fraction zero in the connections pane, regardless of their timestamp. follow
mode therefore cannot track those groups at their actual reading position.

evidence: `apps/web/src/app/(authenticated)/media/[id]/hostedReader.ts:151-154`
maps time-range locators to a `time` reader target. `evidence/EvidencePane.tsx:64-78`
under that directory handles range, quads and point targets only, falling back
to zero for a time target. `:82-94` uses that fraction for following and visible
band marking. this is a source audit; no browser reproduction was run.

prerequisite: resolve a timed target to its actual transcript unit through the
reader's target projection owner. retain a distinct unavailable state when no
readable position exists; do not substitute the document start.

acceptance: multiple connections at distinct transcript times follow and mark
their respective passages as the reader scrolls; an unplaceable timed target
is identified explicitly. this fix is independent of whether the product
uses following or geometric alignment.
