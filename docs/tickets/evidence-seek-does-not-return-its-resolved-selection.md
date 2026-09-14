# evidence seek by source marker cannot be verified by its caller

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: reader evidence / publication query contract

## what is wrong

`apps/web/src/lib/reader/readerPublicationOverlays.ts:220` — the `SourceReference`
branch of the evidence seek — checks only `items[0].kind`, unlike every sibling
read, which verifies the identity it asked for. the caller cannot tell whether it
got the marker it named.

it cannot simply assert `stable_key` equality: a marker that **cites** the
requested key is a legitimate answer
(`python/nexus/services/reader_publication_evidence.py:743-754`), so an equality
assertion would break legitimate seeks.

## prerequisites

the seek response must carry the resolved selection explicitly. that field has to
be added on the wire first — `python/nexus/api/routes/reader_publications.py`,
`python/nexus/schemas/reader_publication.py` and
`python/nexus/services/reader_publication_evidence.py` — or the client assertion
fails on every seek.

## proposed fix

add the resolved selection (the marker identity the server actually chose, and
whether it is the requested key or a citing marker) to the seek response, then
have the client verify it in the same change.

## acceptance

a seek whose server answer is a citing marker is accepted and identified as such;
a seek answered with an unrelated marker is refused by the client. both cases are
proved.
