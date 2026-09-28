# /s reader re-checks an anchor ordinal the server already guarantees

status: open · origin: 2026-09-28 resource-sharing reauthoring review (size/resource-sharing) · area: resource sharing / public reader web

`apps/web/src/app/s/PublicShareReader.tsx` (L139 article, L153 transcript)
renders "Highlight unavailable." when the highlight's text anchor names an
ordinal missing from `reader.fragments` / `reader.segments`. the server builds
the anchor and the list from one `FOR SHARE` snapshot in
`services/public_resource_sharing.py:read_share`, and the create-time gate
refuses a highlight that does not resolve, so afaict the branch cannot run. the
live suite could not construct the case either.

impact: two dead conditionals and the premise that the wire can disagree with
itself; no user-visible effect.

fix: drop both checks and render the list with `markAt` alone. keep the PDF
arm (a page past the last page is a real state) and the EPUB `sections[0]`
fallback, which the spec names.

resolved when: the two `.some(...)` guards are gone, and a shared article and
transcript highlight still open marked and scrolled to on `/s`.
