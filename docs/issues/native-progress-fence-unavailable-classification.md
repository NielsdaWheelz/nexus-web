# native fence unavailability can reach the defect boundary

problem: operational bridge unavailability during progress preparation is not
fully classified by the native adapter.

evidence: `apps/web/src/lib/player/nativeEngine.ts:192-199` maps only
`NotResponding` while its bridge also reports `Unavailable` and `NotConnected`
(`nativeUnavailable`, lines 50-53). this is source review, not handset qualification.

impact: an unavailable native holder can trigger a workspace defect instead of
the existing save/recovery feedback. no bulk write is sent; a prior unconfirmed
command must remain tracked. outside the browser/reader repair in this change.

resolved when: real native fence unavailability is reported as an expected local
preparation failure, retains progress/recovery and any earlier command uncertainty,
and does not reach the defect boundary.
