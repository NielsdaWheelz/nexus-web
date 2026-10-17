# large repaired note map exhausts api memory

status: open; normalized index/detail locally accepted at production limits;
canonical artifacts, deployment and live acceptance pending

ordinary authenticated `GET /media/228d14cf-120c-495c-9e5c-5a3383658843/document-map`
on the fully repaired clone killed the api at its actual384 mib limit. local
fixture image `90b54df9fbe9` contains reviewed `b748a3ace` reader changes over the
canonical695 image. container `ac045aa89ba3` exited137, oom=true, at
2026-10-17 16:31:36 utc; the ordinary bff returned502 after5.024s. no production
read or mutation was attempted. the database stayed running.

impact: source-correct metadata alone does not establish that this book remains
readable. the source-note map includes9,889 target notes. one read-only diagnostic
under a larger isolated limit measured203.9 mib after ordinary api imports,
368.7 mib with raw item rows,449.4 mib after typed apparatus hydration,518.8 mib
after duplicate resource hydration, and606.6 mib peak during map projection.
actual serialization peaked at694 mib for52,710,201 response bytes. the current
fastapi already serializes the typed response directly; a speculative response
encoder replacement would miss the demonstrated cause.

the internal apparatus graph is never a wire response. project its consumed
source fields and retain each validated item once; reuse the existing preview and
routing owners rather than rehydrating the same apparatus items. preserve all
stored provenance and final ordered content. do not truncate notes, relabel
content unavailable or raise production limits.

private evidence: forward-fix-b748a3ace/largest-api-read.json,
largest-api-oom-terminal.json and local-reader-proof/
note-reader-20261017-map-memory-profile-receipt.json. a single read-only baseline
wire oracle is retained for exact comparison; no production read was used.

the first lean-graph correction `a50ad7ee9` passed static and source review but
still failed the actual ordinary384mib read:502 after7.034s, own api container
`3b73f3e641f4` exited137/oom=true at16:59:17 utc. it is not qualified or
deployed. retain this failure and measure the remaining allocation before another
source change. private proof: largest-map-a50-read.json and
largest-api-a50-oom-terminal.json in the same forward-fix evidence directory.

one read-only trace of that candidate retained exact original wire bytes, but
measured a425.9mib graph peak before serialization and525.8mib during direct
serialization. target detail is27,945,001 of the52,710,201 response bytes.
removing unused repair provenance is insufficient; the complete target graph is
being loaded for closed disclosures.

forward correction: keep existing bounded reference rows, actions, groups,
markers, ordering and counts in the map. fetch complete ordered targets only
when their reference opens, under the same visibility and publication identity.
preserve the publication-wide lightweight link-alias index and edge-to-owner
association mapping. remove eager `source_targets`; do not fabricate unavailable
content or a new generic row framework. this hard cut requires wire11 and paired
clients, with one extra detail read on disclosure. no migration or budget increase.
the lazy-detail candidate `8bb214141` passed static checks but still killed the
actual384mib api:502 after4.405s; `ac6ac5f798b6` exited137/oom=true at17:37:31 utc.
one instrumented ordinary authenticated request under diagnostic1gib returned
24,765,182 bytes, exactly the original map except removed eager targets. its
single-request peak was384,991,232 bytes; the typed graph was335,187,968 bytes
before serialization. that diagnostic is not a production-limit pass.

the remaining map repeats full resource presentation and source attribution for
9,889 reference rows. normalize the source attribution once and retain explicit
per-reference excerpt, label, location, activation, resource/action refs and
associations. adapt these genuine facts into the existing resource row only when
mounted. preserve every action and exact ordered content; detail remains complete.
wire11 is still unreleased. private failed-candidate proof: http-memory-8bb-request.json,
http-memory-8bb-parity.json and note-reader-20261017-httpdiag-8bb-trace.jsonl.

combined `726976d8e` passes the ordinary authenticated reader-state/map/warm
detail sequence at384mib, zero extra swap and zero oom events; peak343,371,776
bytes. expanding normalized rows reproduces the original map values exactly
except removed eager targets, and complete ordered detail matches the original.
the actual largest-book reader displays its1,937-character note, collapse removes
rich dom, generic linked-resource read returns200, action href and escape focus
are preserved, and the absent cursor stays exact with zero progress writes.
short-note, positioned-cursor and article controls also pass. these are isolated
real-stack proofs, not canonical-artifact or live acceptance. private receipts:
largest-lazy-contract.json, normalized-largest-web.json and
note-reader-20261017-normalized-map-memory.json.

resolved by a complete ordinary authenticated reader/map and rendered note
interaction passing within the actual384 mib api limit, with exact source-derived
content and unchanged protected state. retain the failed result and the observed
allocation cause; qualify the combined correction before the next deployment.
