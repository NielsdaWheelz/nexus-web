# folded provenance slivers at 200% type

a fold no longer sets a publication gap, so the bibliography keeps the row's and takes
both sides of its separator from the line. provenance, which grows within what is
left, pays for them: 8px at 100% type, 16px at 200%.

impact: cosmetic, and accepted, since `origin/main` shows 0px there. at a 270px row and
200% type, which a 334px viewport reaches, `from <source>` keeps 9px, under one
character. byline and facts stay whole, and wider rows keep room.

evidence: 2026-11-01 lab case, the `facts provenance` row in a library, desktop and
touch. with the fold's former `0px` gap, visible provenance was 25px at 270px and 200%,
and 147.5px as the least across folded rows at 100%; without it, 9px and 139.5px. at
`84cb16847` the 270px, 200% row shows 0px. the case's provenance oracle asks for 24px;
it stands red on these two samples.

resolved when that row keeps 24px of provenance at 270px and 200% type, or the owner
sets a lower bound and the row meets it.
