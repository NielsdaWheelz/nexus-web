# atlas

status: representation-tag repair live-qualified; static gate passed · 2026-10-02

## read model and visibility

`python/nexus/api/routes/atlas.py` owns authenticated `GET /atlas` and its
`{data:{stars,constellations,edges}}` representation. `schemas/atlas.py` owns
every required field: stars have media_id, independently nullable x/y, title,
kind and the viewer's highlight-count magnitude; constellations have library_id,
name and member_media_ids; edges have source_media_id,target_media_id,kind,origin.

corpus media come from the viewer's default virtual relation over current
non-system library memberships. membership in a shared library contributes its
visible media; system-only oracle works stay excluded. constellations cover those
member libraries, omit empty groups and name the viewer's default `All`. default
membership ids reuse the star ids. edges belong to the viewer, have both media
endpoints in that personal relation, and are synapse context or contradicts edges.
opaque ids confer no authority.

queries and array construction remain unchanged. the sql does not specify stable
array ordering; the tag identifies the actual returned representation, including
whatever order those queries returned. no sorting or array normalization is added.
`services/atlas_projection.py` remains the position writer. computed_at no longer
controls the tag; its existing query selection/grouping remains a
[recorded follow-up](../tickets/atlas-star-query-reads-unused-position-timestamp.md).

## conditional http owner

the route assembles validated `Data[AtlasOut]`, declares that response model
explicitly, and renders one `JSONResponse` from
`model_dump(mode="json",by_alias=True)`. sha256 of its exact body is the opaque
quoted `ETag`. the existing single-tag comparison stays: strip surrounding quotes
from `If-None-Match` and compare. a match returns bodyless 304 with the same tag;
otherwise the already-rendered 200 response is returned.

all read queries run before the conditional decision. this covers titles,
highlight counts, memberships, library names, placements, positions and edges
without a cross-owner revision ledger. the previous max-position-timestamp tag
could miss every non-position change.

this is the named [typed-wire exception](../local-rules/typed-wire.md): standard
`JSONResponse` float/unicode rendering preserves the old body bytes, and its
rendered body is available for hashing. installed fastapi's normal typed-model
response uses pydantic json spelling instead. returning a model through an explicit
`JSONResponse` class would still require another render before deciding the tag.
the chosen codec is one HTTP boundary, with no alternate serializer or fallback.

## browser owner and qualification

`GrandAtlasPaneBody.tsx` consumes the generated response/schema types in place of
four duplicate dtos. its corpus/nebula geometry, brightness, constellation labels,
edges, layers, selection and activation stay unchanged. there is no atlas transport
decoder to retire. lazy oracle readings and concordance are separate boundaries.

qualification must preserve exact real 200 bytes, including small floats,
nullable positions and unicode. unchanged representations must return 304,
including empty atlas; contributing read-model changes must invalidate prior
tags without position recomputation. shared/non-system visibility must survive.
live qualification on 2026-10-02 preserved literal baseline bodies for both
viewers, including unicode, `1e-05` and null positions. seven contributing changes
invalidated prior tags; unchanged and timestamp-only changes returned 304.
other-user highlights preserved the first viewer's tag, and all visibility/edge
filters and auth 401 survived. independent sha256 matched the response bodies;
empty atlas and quoted/unquoted conditional tags passed.

the real browser rendered two corpus stars on its canvas without page errors;
manual bff requests verified 200/bodyless 304. the normal consumer issued no
conditional request. oracle readings, provider/position workers and broader canvas
interactions were not exercised. temporary fixture/probe cleanup belongs to the
qualification owner. `./scripts/test` remains the sole static gate.
