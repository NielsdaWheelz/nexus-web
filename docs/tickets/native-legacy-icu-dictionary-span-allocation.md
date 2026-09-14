# native legacy word segmentation can materialize a full dictionary span

- status: open
- origin: 2026-09-13 bounded-workspace runtime review
- area: native legacy publication conversion / word boundaries

an 8KiB file-backed `CharacterIterator` bounds the supplied text view, but not
ICU's internal dictionary word segmentation. Android 35 `CjkBreakEngine`
`divideUpDictionaryRange` allocates `int[inputLength+1]`, copies the entire
span into `StringBuffer`/`String`, normalizes it, then allocates several arrays
proportional to its code-point count (lines135–197,262).

[source](https://android.googlesource.com/platform/prebuilts/fullsdk/sources/+/refs/heads/androidx-constraintlayout-release/android-35/android/icu/impl/breakiter/CjkBreakEngine.java)

prerequisite: distinguish the required publication Unicode word-boundary
semantics from locale dictionary word segmentation. reuse a maintained owner
that matches the former with bounded input/working state; do not insert
artificial word boundaries to limit allocation or silently omit supported
scripts. grapheme iteration needs its own allocation review.

acceptance: exact boundary parity across existing Unicode source fixtures,
including long dictionary-script runs; actual maximum-source native memory
measurement within the release profile. a retained file-backed input alone
is not evidence that the segmentation internals are bounded.
