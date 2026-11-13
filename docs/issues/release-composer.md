# composer release

deploy the receipt api and adopting web together: accepted admission now carries
only `turn`, replacing run/message identity fields. no old-wire reader remains.

wire remains 23, the pending break. before release, confirm the deployed api's
wire identity through the release owner: the public web `/version` alone is not
api evidence. if 23 has shipped, bump once and re-pair extension and apk; otherwise
this change rides 23. there is no schema migration.

reference-quotes must start from this cut's tip. before its first lane, diff its
spec against `schemas/chat.py`, `chat/admit.py`, `ChatComposer.tsx`, `drafts.ts`,
`commands.ts`, `wire.ts` and `docs/librarian-spec.md`. preserve the turn receipt,
adoption ordering and rewritten line while replacing reference payloads.

resolved when the paired api/web release is identified and verified, any required
clients are paired, and reference-quotes has reconciled its starting contracts.
