# media evidence route ignores its owner path

status: open · origin: 2026-09-17 cleanup review · area: reader evidence

`python/nexus/api/routes/reader.py:40-51` accepts `media_id` but passes only
`evidence_span_id` to the resolver. the service authorizes the evidence's actual
owner; a different readable owner's span can therefore produce a successful
response under the wrong media url. the browser rejects that response in
`mediaEvidenceResolution.ts`, so this is an inconsistent route contract, not
an authorization bypass.

reproduced against main `dd26fc680` with postgres schema `0233`: nine actual
fastapi requests under an unrelated media id returned 200 and the same payload
as the correct owner path. fixtures used transaction-local rows; no production
data was involved.

prerequisites: none. reject a resolution whose owner differs from the path at
the existing route boundary, using the ordinary not-found response.

acceptance: matching owner succeeds; mismatched, missing and inaccessible
evidence return not found. internal evidence resolution remains owner-neutral.
