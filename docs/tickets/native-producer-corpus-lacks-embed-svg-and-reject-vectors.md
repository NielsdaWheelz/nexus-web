# the native producer corpus cannot exercise embed, SVG-paint or schema-2 rejects

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: native offline reading proofs / cross-language corpus

## what is wrong

decoding all four committed producer archives shows that **no** unit carries a
`document_embed` or an object-valued SVG paint attribute, and only
`retained-epub-schema-2` carries an `epub_target` (one unit). so the embed,
SVG-paint, epub-default and opaque-identity acceptance rules are proved only
against a hand-authored Kotlin fixture
(`OfflineReaderPublicationFixture.kt:41`), never against producer output. the
SVG-paint proof is now honestly named (`svg paint keeps decoded fragment identity
and literal fallback, hand authored wire only`), which makes the gap visible but
does not close it.

separately, the **shipping** schema has no reviewed reject corpus.
`testdata/offline-reading-contract-v1.json` was restored as a non-vacuous
consumer — each of its three schema-1 packages must be refused as
`UnsupportedPackage`, not `Integrity`, and deleting the schema guard at
`OfflineReadingPackageVerifier.kt:77` turns that red — but that only covers the
retired format.

## prerequisites

a producer source that actually contains a table, a captured asset, an embed and
an object-valued SVG paint, run through the real packager; plus
`testdata/offline-reading-contract-v2.json` with its `testdata/manifest.json`
provenance row and a Python consumer.

## proposed fix

extend the producer fixture source so the committed archives carry these shapes,
repoint the four Kotlin proofs at them, and add the schema-2 reject corpus with
consumers in both languages.

## acceptance

the embed, SVG-paint, epub-default and opaque-identity proofs read producer
archives; a schema-2 package violating each reviewed reject vector is refused with
the named reason from both Python and Kotlin.
