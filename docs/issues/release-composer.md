# composer release

deploy the receipt api and adopting web together: accepted admission now carries
only `turn`, replacing run/message identity fields. no old-wire reader remains.
pair saved-reference inputs and their admission proofs with the turn receipt and
the web's atomic draft-to-transcript adoption.

wire remains 23, the pending break. before release, confirm the deployed api's
wire identity through the release owner: the public web `/version` alone is not
api evidence. if 23 has shipped, bump once and re-pair extension and apk; otherwise
this change rides 23. composer adds no migration.

the release source includes reference-quotes migration 0344 and its saved-quote
conversion. follow [reference-quotes release](release-reference-quotes.md) for
stopped writers, verified backup, exact-head migration and conversion ordering.

resolved when the paired api/web release is identified and verified and any
required revision pairing is complete.
