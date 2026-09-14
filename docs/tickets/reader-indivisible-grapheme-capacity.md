# indivisible graphemes exceed the candidate unit bound

status: open
origin: 2026-09-14 bounded-workspace native maximum-source review
area: canonical source partitioning

`OfflineReadingLegacyUnits.kt:154–168` preserves icu grapheme boundaries while
`OfflineReaderPublicationVerifier.kt:11` caps a unit at 65,536 code points.
accepted 64 mib encoded legacy reader data can contain one base character plus
more than 65,536 combining marks. that source has no legal interior grapheme
cut. the maximum ascii workload cannot qualify this shape. this is a contract
incompatibility, now observed at the actual converter boundary below.

characterize the actual supported long-cluster source through the producer and
native converter. agree one lossless representation or qualified bound that
preserves canonical positions and source availability. do not silently truncate
the cluster or count permanent conversion refusal as completed support.

acceptance: actual long-cluster source receipts, bounded normalization/partition
memory, a readable source-preserving result, and matching native/browser behavior.

the [concrete option comparison](../cutovers/reader-indivisible-atom-options.md)
records source maxima, existing-schema admission costs, and why storage paging
alone does not qualify continuous shaping and selection. no option is activated.

actual candidate red `0855e169907e194d` at isolated `f5ff26e56b`: an attested
262,390-byte reader, sha256
`7b64a2ca72dcb5534956488464f80fbaf0c9538f604e5f02deb626bbc98bafa8`, contains
one paragraph of `q` plus 65,536 combining acute marks. icu confirms exactly one
65,537-code-point grapheme; source staging accepts it and preserves its exact
canonical bytes. `stageLegacyReaderPackage` then throws
`canonical grapheme exceeds publication capacity`. the same candidate passes
the 64 mib ascii source case. original file hash remains unchanged.

the added case exists in that immutable audit commit and its retained junit
artifact; the active native proof restored its original html owner afterward.
the run's original html-substitution red is separate from this actual candidate
failure. no supported input limit or grapheme rule was changed.

maximum-size candidate also fails: `312e8d38541cb232` at `f254aca819`.
the 67,108,864-byte recipe in the option comparison is admitted unchanged,
with 22,369,541 canonical code points in one ICU grapheme. publication rejects
the same capacity contract after 5.076 seconds; derived preparation is not
reached. sampled host JVM heap peaks at 188,829,800 bytes, through rejection
only. the complete unit's layout, selection and concurrent retention remain
unmeasured. original ordinary html proof is restored at `aa1aa809fe`.
