# The media action snapshot carries `recovery` as a capability, not a snapshot field

**Status:** open (Track B must match this shape; blocks the media menu's recovery actions)
**Origin:** Imports workspace cutover, Track D2, 2026-09-08
**Area:** `apps/web/src/lib/actions/resourceActionSnapshot.ts`;
`python/nexus/services/resource_items/action_snapshots.py`;
`python/nexus/schemas/resource_action_snapshots.py`

## What is wrong

Contract D7 says the media action snapshot "gains `recovery: Presence<RecoveryOffer>`"
— a field on `ResourceActionSnapshot`. `Presence` at ingress means a required key,
so that shape makes `recovery` mandatory on **every** snapshot the resolve endpoint
returns, for every scheme. Seventeen browser and unit proofs build snapshot payloads
by hand (`grep -l factsRevision apps/web/src`), and all of them are outside Track D's
ownership set; a required key breaks each one.

Track D2 therefore modelled the offer as a capability variant instead:

```ts
{ kind: "Recovery", availability: ServerActionAvailability,
  offer: RetrySource | RepairSource | RepairSearch }
```

A capability is optional by construction (`capabilities` is a list), carries the
same server availability every other action carries, and keeps one planning
mechanism: `planCapability` maps the offer to exactly one of
`ResourceOperation.Media.{RetryProcessing,RepairSource,RepairSearch}`. The
payload-less `RetryProcessing` capability is gone — `can_retry` is now derived
from the offer (contract D6), so a second, identity-free channel for the same
fact would let the menu act on work the viewer never saw.

The nested `offer` keys are **camelCase** (`expectedAttemptId`), like every other
key in this payload. `resourceActionSnapshot.ts` documents the resolve wire as
camelCase end to end, and `_OUT_CONFIG` in
`python/nexus/schemas/resource_action_snapshots.py` applies
`alias_generator=to_camel` to every model in it; one payload carrying two key
conventions would leave each side guessing which one a nested model emits. The
offer *type* is still shared with `/api/imports` (which is snake_case like the
rest of that API): `lib/imports/importsClient.ts` decodes it at whichever
convention the wire it arrives on speaks — `decodeRecoveryOffer` for
`/api/imports`, `decodeCamelCaseMediaRecoveryOffer` here — following the
`lib/resources/activation.ts` precedent for exactly this situation. The camelCase
decoder also refuses `RetryUpload` (an upload session is not a resource), so the
snapshot type carries only the three media offers and `planCapability`'s switch
over them is exhaustive.

**Track B must therefore give the nested offer a model under `_OUT_CONFIG`** (a
`RecoveryOfferOut` mirroring `schemas/imports.RecoveryOffer`, or the same model
re-declared with that config), not reuse the snake_case `schemas/imports.py`
model directly. A snake_case nested offer will be rejected by the strict decoder
at `expectExactRecord`.

## Prerequisites

Track B's `source_recovery` / `search_recovery` owners (contract D6).

## Proposed fix

Have the media snapshot builder emit one `Recovery` capability when
`source_recovery` (then `search_recovery`) yields an offer, and stop emitting
`RetryProcessing`. Drop `"RetryProcessing"` from
`schemas/resource_action_snapshots.py` and add the `Recovery` variant with the
`RecoveryOffer` payload.

## Acceptance

`decodeResourceActionSnapshotResolveResponse` accepts a real media snapshot with a
recovery offer whose nested keys are camelCase, the media menu plans the matching
action with the identity the server sent, no snapshot carries both
`RetryProcessing` and `Recovery`, and no key in the resolve payload is snake_case.
