# lectern player title length units disagree

status: open · origin: 2026-10-04 source audit · area: lectern player display

`python/nexus/services/consumption/projection.py:375–388` truncates a podcast episode title with python `[:300]` and copies it into `player_display`. `apps/web/src/lib/lectern/contract.ts:539–543` rejects that title when javascript `title.length > 300`. the same conflict applies to chapters: `python/nexus/schemas/consumption.py:24–25` and `services/consumption/projection.py:350–353` bound python code points, while `apps/web/src/lib/lectern/contract.ts:405–419` bounds javascript utf-16 units. a 151-astral-character title can pass the native producer and fail either browser decoder at 302 units. this is source-qualified; no runtime failure has been observed.

acceptance: choose and enforce one explicit title-length unit at the producer/domain contract, then verify astral and ordinary display and chapter titles through native output, browser decoding and the live android chapter ingress without changing activation or listening behavior.
