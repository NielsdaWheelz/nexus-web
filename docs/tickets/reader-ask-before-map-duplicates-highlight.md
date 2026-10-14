# reader ask can race its saved-highlight map

status: open · origin: 2026-10-14 final release acceptance, `665e7b3af03282d37ac1a2aac3c6589e2a0f5932` · area: reader / quote chat

on a fresh reader load, select an already-highlighted passage and choose ask
before its document map arrives. `annotations.ts:198` checks `twin` against the
loaded map; without that map it posts the same span again. the server returns
`409 E_HIGHLIGHT_CONFLICT`, and no chat opens. this is a handled refusal, not a
workspace crash or an uncertain mutation acknowledgement.

actual keats attempt: highlight request started at21:08:55.531z; document-map
request169 completed200 at21:08:55.655z; highlight request181 returned409
at21:08:55.790z, request id `ef27efea-218f-4d1e-87b3-875eca2ff396`.
no chat run had been submitted. original requests, responses, first console
error and screenshot are private under
`/tmp/nexus-release-20261014/web-phase6-665e7b3af-final-acceptance/`.
the frozen durable copy is campaign
`2026-10-13/release/web-final665-acceptance-20261014T2126Z/evidence/`;
its files manifest sha256 is
`99fbde3494cc764d87d256681c990cccbe841ba51faa3024251b3c7070f6bcbf`.

fix at the annotation verb owner: make ask resolve the saved extent before
creating its highlight, preserving visibility and exact-span ownership.
do not retry an uncertain creation with a new key.

acceptance: on a cold reader load, ask on an existing marked span opens the
quoted chat without a duplicate-highlight refusal or extra highlight. retain
the original map/selection timing in manual proof.
