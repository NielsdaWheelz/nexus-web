# The media-kind Literal has no single owner

**Status:** open (found while writing `nexus/schemas/imports.py`; not fixed there)
**Origin:** 2026-09-08, imports workspace hard cutover, Track C1
**Area:** `python/nexus/schemas/*` wire contracts

## What is wrong

`Literal["web_article", "epub", "pdf", "podcast_episode", "video"]` is written
out separately in four places, and the media response that should own it is
untyped:

- `python/nexus/schemas/library.py:291` (`LibraryEntryMediaOut.kind`)
- `python/nexus/schemas/imports.py:44` (`MediaKind`, added by this cutover and
  read by `ImportItem.media_kind:227` and `ImportSummaryQuery.media_kind:308`)
- `python/nexus/schemas/consumption.py:34` reorders the same members as
  `ConsumptionMediaKind`
- `python/nexus/schemas/media.py:285` is `kind: str  # "web_article", ...`, so
  `nexus/services/imports.py` has to `cast(...)` the value back into the
  Literal at every projection.

Adding a media kind therefore fails to type-error in every consumer, which is
exactly what `docs/rules/control-flow.md` (exhaustiveness) requires it to do.

The imports cutover contract assumed the alias already existed in
`nexus/schemas/media.py` ("`MediaKind` = existing `Literal[...]`"); it does not,
so Track C1 declared a fourth copy rather than retyping `MediaOut.kind`, which
is owned by another track and reaches unrelated consumers.

## Prerequisites

None. The prerequisite this ticket was filed with is met: the imports cutover
has landed on this branch — `python/nexus/schemas/media_activity.py` is deleted
and `python/nexus/schemas/imports.py` is its replacement — so the consolidation
no longer conflicts with in-flight work.

## Proposed fix

Declare `MediaKind` once in `nexus/schemas/media.py`, retype `MediaOut.kind` to
it, and import it from `schemas/imports.py`, `schemas/library.py` and
`schemas/consumption.py` (`ConsumptionMediaKind` becomes an alias of it or is
deleted). Delete the `cast` at each media-kind projection site.

## Acceptance

One `Literal` declaration of the media kinds in the repository, `MediaOut.kind`
typed by it, no `cast` to a media-kind Literal anywhere, and
`./scripts/test` passes.
