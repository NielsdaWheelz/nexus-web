# public share treats every asset conflict as changed content

problem: an asset response with status409 triggers the content-changed flow; a second one says `this reading changed since it opened.`.

impact: contention can reload a reading unnecessarily, then replace it with an unsupported change claim.

source: frozen `72cf9db84efc47966a09cc888309b013228fa3b9`; assets at `apps/web/src/app/s/publicSource.ts:63` and apparatus at `apps/web/src/app/s/PublicShareReader.tsx:263` both call the same flow at `PublicShareReader.tsx:68-75,166-167`; `python/nexus/api/edge.py:93-99` also emits a409 for database contention.

resolution: absent a typed identity cause, proposed final fact `couldn’t load this reading’s contents.` with `retry` reading again, or another neutral existing recovery preserving the identity safety fence. the shared path includes both images and apparatus. no generic409 change claim. prove repeated contention never asserts changed content and actual identity mismatch still cannot display stale assets.

status: source finding only; no runtime journey run. correction and behavior qualification remain pending.
