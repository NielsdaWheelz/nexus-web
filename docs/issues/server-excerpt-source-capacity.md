# server excerpt source capacity

server capture maps every character of a retained fragment before bounding a
small selection. the new provenance graph can exceed the helper's 128 mib heap
for ordinary admitted sources. the exact failure threshold is not yet measured.

evidence: `services/source_excerpt.py:239-240` builds whole trees and calls
`excerpt_canonical_maps`; `node/authored/src/excerpt.ts:197-224` retains per-character
tokens, endpoint objects and output provenance. source search, tool highlight
creation, quote capture and passage creation call this path. web articles permit
10 mib input and publish one fragment; epub chapters permit 16 mib decoded xhtml
(`services/web_article.py:57,262`, `services/epub_ingest.py:123-124`; python paths
under `python/nexus`). serialized helper batching does not bound expanded memory.

prove with a real large imported source and a short server-side passage request.
resolve at source/provenance projection ownership: bound retained provenance to
the requested evidence while preserving canonical coordinates and source proof.
keep existing heap and admission limits; qualify exact literal text and structure.
