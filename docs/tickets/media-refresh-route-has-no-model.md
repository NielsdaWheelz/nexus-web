# media refresh route has no response model

status: open · origin: 2026-10-10 imports reauthor (cleanup/imports-reauthor) · area: api / typed wire

`POST /media/{id}/refresh` (`python/nexus/api/routes/media.py:168`) returns `-> dict`, so `wire.gen.ts` types its body as untyped and `lib/imports/api.ts` `refreshMediaSource` reads it as `apiFetch<unknown>` and ignores it. the repair route got its model in the imports reauthor (`MediaRepairAdmission`); this is the last untyped recovery-adjacent route the imports client calls.

fix: give the route a response model through `Data[...]` with identical json bytes, regenerate the wire, and type the web call.

acceptance: `wire.gen.ts` names the refresh response; `refreshMediaSource` reads a generated type; the response bytes are unchanged.
