# `player_descriptor` is installed after the media DTO is built

**Status:** open (found while fixing the `source_progress` serializer defect; not fixed there)
**Origin:** 2026-09-08, imports workspace hard cutover, Phase 4 chain M
**Area:** `python/nexus/services/media.py` (`_apply_consumption_state`)

## What is wrong

`_media_out_from_row` builds every `MediaOut` with `playerDescriptor=absent()`,
and `_apply_consumption_state` (`python/nexus/services/media.py`, the
`episode_media_ids` branch) then installs the derived descriptor by rebuilding
the whole DTO:

```python
values = {field_name: getattr(media, field_name) for field_name in MediaOut.model_fields}
values["player_descriptor"] = {"kind": "Present", "value": descriptor}
media_outs[index] = MediaOut.model_validate(values)
```

The comment on that block records why: a plain post-construction assignment
leaves a `Present[...]` specialized under a different parametrization than the
field declares, and the value then warns when `MediaOut` is nested inside
`LibraryEntryOut`. That is the same defect class chain M removed for
`source_progress` — a `Presence` value produced somewhere other than the
constructor of the model that declares the field — and the workaround costs a
full re-validation of every podcast-episode row on every media list read.

Only the workaround is in place; the defect class is still reachable for any
future field installed the same way.

## Prerequisites

None beyond the imports cutover landing (`services/media.py` is edited by
several of its tracks).

## Proposed fix

Load the player descriptors before the DTOs are built (the projection owner
`consumption.projection.player_descriptors` is already a batch read), pass the
`Presence[PlayerDescriptor]` into `_media_out_from_row` the way
`source_progress` is now passed, and delete the `model_validate` rebuild and
its comment. `_apply_consumption_state` keeps only the per-viewer read-state
and recency assignments, which are plain scalars.

## Acceptance

No `MediaOut.model_validate` rebuild in `services/media.py`, `player_descriptor`
supplied at construction, and manual media list/detail reads preserve the
podcast player descriptor and in-flight source progress without serialization
warnings.
