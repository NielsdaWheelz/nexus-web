# the native publication verifier retains one identity per anchor and section

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: native offline reading / publication verification

## what is wrong

`apps/android/app/src/main/java/app/nexus/android/offline/reading/OfflineReaderPublicationVerifier.kt:101`
retains one identity string per anchor (`pendingAnchors`), per section
(`sectionIds`), per navigation/toc/display id and per embed UUID, so verifier
heap scales with **document content**, not with the enforced 4,096-member bound
the contract comment at `:61-63` claims. that comment is currently false and was
deliberately left in place rather than laundered.

`navigationSections` (`:67`) and `embedIds` (`:88`) have the same unbounded
shape. `embedKeys` is per-fragment bounded (cleared at `:162`) and is fine.

two alternatives were considered and rejected: a temp SQLite table is not
available (six of these test classes are plain-JVM without
`@RunWith(RobolectricTestRunner)` and `app/build.gradle.kts` sets no
`returnDefaultValues`, so any `android.database.sqlite` reference inside
`verify()` throws "not mocked"); and 64-bit fingerprints shrink a constant
without bounding the structure, while weakening collision resistance on an
adversarial ingress path.

## prerequisites — two-sided, do not land half of it

**(a) producer first.**
`python/nexus/services/reader_publication_artifacts.py:548` must emit
`sorted(anchors.values(), key=lambda a: (a.href_path, a.anchor_id))` instead of
`list(anchors.values())`; anchors are inserted in unit order at `:388`, so the
wire is currently unordered. sections must likewise be emitted in strictly
ascending `ordinal` across the index chain. this makes producer order normative.

**(b) verifier second, only after (a) ships and the committed testdata archives
are regenerated.** replace `anchorIdentities` (`:68`, added at `:101`) and
`sectionIds` (`:66`, added at `:114`) with a comparison against the **previous
row only** — strictly ascending `(href_path, anchor_id)` for anchors, strictly
ascending `ordinal` for sections — and verify the contents chain against the
index chain by walking both chains in parallel in the second pass it already
performs (`:409-429`) rather than against a retained map. that is O(1) heap and a
strictly stronger check than set uniqueness.
`OfflineReadingLegacyIndex.kt:158` already emits `ORDER BY href_path, anchor_id`,
so the native converter needs nothing.

**(c)** landing (b) alone rejects **every** hosted schema-2 package at ingress,
and the committed archives carry too few anchors to make that visible in proof.

**(d)** while there, update the contract comment at `:61-63` to include
`navigationSections` and `embedIds`.

## proposed fix

as prescribed above, (a) then (b), with the archives regenerated between them.

## acceptance

verifier heap is flat in anchor and section count over a regenerated maximum
archive; an out-of-order anchor or section is refused; every committed schema-2
archive still verifies.
