# public share treats every asset conflict as changed content

problem: an asset response with status409 triggers the content-changed flow; a second one says `this reading changed since it opened.`.

impact: contention can reload a reading unnecessarily, then replace it with an unsupported change claim.

source: frozen `72cf9db84efc47966a09cc888309b013228fa3b9`; assets at `apps/web/src/app/s/publicSource.ts:63` and apparatus at `apps/web/src/app/s/PublicShareReader.tsx:263` both call the same flow at `PublicShareReader.tsx:68-75,166-167`; `python/nexus/api/edge.py:93-99` also emits a409 for database contention.

stronger backend proof: `python/nexus/services/public_resource_sharing.py:829-831` ALREADY distinguishes actual identity mismatch as `E_READER_CONTENT_CHANGED`. the consumer loses that distinction by testing status alone.

resolution: trigger the existing changed-content flow only for the existing typed `E_READER_CONTENT_CHANGED` cause. retain `this reading changed since it opened.` there. generic409 needs ordinary read recovery or a neutral fact such as `couldn’t load this reading’s contents.` with `retry`; no new wire code. prove repeated contention never asserts changed content and actual typed identity mismatch still cannot display stale assets.

status: source finding only; no runtime journey run. separate writer required.
