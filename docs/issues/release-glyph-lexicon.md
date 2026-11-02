# release glyph lexicon

the glyph lexicon changes drawings, one stroke weight, lint and one visible word
(the find bar's `results`). no wire, schema or storage change, so `WIRE_REVISION`
stays. web deploys alone, with no preflight and no owner step, or rides the
feedback-homes release if that is still unshipped.

the apk and the firefox extension serve their own bundles. the phone takes the
lexicon on its next signed apk, the extension popup on its next signed xpi; until
then a stale client differs from web only in drawings, their stroke and, on the
phone, the find bar's word. nothing it sends or stores differs.

resolved when web is deployed from the merge sha. the next signed apk and xpi
carry it by construction; neither needs its own release.
