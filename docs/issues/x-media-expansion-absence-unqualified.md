# x media expansion absence needs provider qualification

status: unverified provider-contract question
origin: 2026-10-14 independent x title review
area: x acquisition

`python/nexus/services/x_client.py:231` rejects capture when a requested primary or
direct-target media key lacks its expanded media object. current normalization
requires a known media type; silently dropping the attachment would invent absence.
the old renderer tolerated missing media. the live image case returned its object;
there is no observed valid omission in this qualification.

the [x expansion contract](https://docs.x.com/x-api/fundamentals/expansions) describes
media objects for requested attachment keys but does not settle withheld/deleted
asset behavior. preserve an actual sanitized partial response/error before changing
the schema or failure policy. no guessed `unknown` type or empty replacement.

acceptance: establish legitimate partial-media semantics from the provider, qualify
them at ingress, and either confirm visible capture failure or model the observed
missing metadata explicitly while preserving readable source and attribution.
