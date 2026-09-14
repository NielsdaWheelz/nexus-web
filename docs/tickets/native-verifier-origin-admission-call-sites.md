# the publication verifier's origin admission has three unmigrated call sites

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: native offline reading / find metadata admission

## what is wrong

`OfflineReaderPublicationVerifier` now takes
`verify(directory, manifest, origin)` with
`internal enum class PublicationOrigin { Downloaded, Retained }`: a null
`word_boundaries` is admissible only under `Retained` ("downloaded publication
unit omits Find metadata"), and under either admission a present list must be
non-empty when the unit has text and must start at `start_cp` and end at `end_cp`
("publication unit Find boundaries do not span its canonical range"). the span
rule is producer-shaped, decoded from the committed archives, not invented.

the three call sites that must now supply the admission are outside the package
that made the change, and **the module does not compile until they do**.

## prerequisites

none; the change is mechanical. each call site already knows whether the package
it is verifying was downloaded or is a retained/converted copy.

## proposed fix

pass `PublicationOrigin.Downloaded` on the download/ingress path and
`PublicationOrigin.Retained` on the conversion and installed-verification paths.
`OfflineReadingLegacyUnits.kt` continues to emit null `word_boundaries` per the
recorded decision.

## acceptance

the module compiles, a downloaded package missing `word_boundaries` is refused,
and a retained one is admitted.
