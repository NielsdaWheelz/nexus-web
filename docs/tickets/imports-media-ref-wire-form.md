# `ImportItem.media_ref` carries a bare UUID, not the spec's `MediaRef`

**Status:** decided in favour of the spec (Track D2, 2026-09-08); Python side still to follow
**Origin:** Imports workspace cutover, Track D1, 2026-09-08
**Area:** `python/nexus/schemas/imports.py`; `apps/web/src/lib/imports/importsClient.ts`

## What is wrong

The spec's wire notation says `ImportItem = { ..., media_ref: Presence<MediaRef>,
... }` (`docs/cutovers/imports-workspace-hard-cutover.md`) — the resource ref
`media:<uuid>` the rest of the app speaks, and the form the resource-action
runtime needs to plan a media action. The implementation contract §4 and
Track C's `schemas/imports.py` (`media_ref: Presence[UUID]`) both carry a bare
UUID instead.

The browser decoder follows the producer (`expectCanonicalRfcUuid`), so the two
agree today, but a reader of the spec will expect the ref form, and every
consumer that needs a ref has to re-format `media:${mediaId}`.

## Track C1's position (owner of `schemas/imports.py`)

C1 wrote the bare UUID because contract §4 spells the field
`media_ref: Presence[UUID]` and §0 makes the contract binding on the tracks; the
disagreement with the spec's `Presence<MediaRef>` should have been reported by
C1 and was not. C1 has no preference between the two forms and will follow
whichever this ticket settles: `schemas/imports.py:216` is a one-line change,
and `ImportItem.ref` already carries the `media:<uuid>` grammar, so the ref form
costs nothing on the producer side either.

## Proposed fix

Either change the spec's notation to `Presence<UUID>`, or change
`schemas/imports.py` and the browser decoder together to the ref form. Do not
accept both.

## Acceptance

Spec, `schemas/imports.py` and `importsClient.ts` name the same form, and the
Imports pane plans a media resource action without a second grammar.

## Decision (Track D2, 2026-09-08)

The ref form wins, per the spec's `Presence<MediaRef>` and contract D16 ("`media_ref`
is the canonical resource ref text `media:<uuid>`"). `importsClient.ts` now decodes
`media_ref` with `parseResourceRef`, requires the `media` scheme, and yields a
`CanonicalResourceRef` the resource-action runtime can consume without a second
grammar; `importsClient.unit.test.ts` has a named case refusing a bare UUID.

Remaining work, outside Track D's ownership: `python/nexus/schemas/imports.py:216`
must become the ref text (`media_ref: Presence[ResourceRefText]`, formatted
`f"media:{media_id}"`) and `services/imports.py` must format it. Until then the
browser decoder rejects the producer's payload.
