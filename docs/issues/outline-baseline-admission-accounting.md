# occurrence baselines escape the session byte budget

`outlineController.ts::bytes` at `ec33256fa` charges unique canonical document
encodings plus history metadata, while `OutlineBinding.bind` independently
allocates a displayed ydoc for each occurrence. aliases of one large note can
therefore exceed the accepted 16 mib admission budget without increasing the
canonical-document count. retaining hidden history bindings makes their charge
necessary too.

real browser run `20261026-032516-e857afde0ad0` on `dcc6c2e5f` (unchanged old
controller) admits 17 aliases of one 940k-character note. their measured encoding
plus the canonical copy totals 16,921,440 bytes, exceeding 16,777,216 while the
fixture's unique documents/tails remain below 64. the byte-bound assertion fails
in 11.6 seconds; later writing and branch-release assertions do not run. this is
an admission failure, not a measured heap or 100,000-note capacity result.

charge independent displayed/frozen baseline encodings through their existing
binding/pending owners, including prospective new aliases. retain the 64 distinct
document bound and protection of accepted writing/remote growth. release charges
only with actual owner release; visual placement anchors must not retain docs.

resolve with repeated large-note aliases: refuse new admission at the byte bound,
preserve accepted writing/focus, and admit again after inactive baselines/history
retire. qualify hidden undo/redo frontier preservation separately.

`671837d36` passes the same byte-admission/refusal, occurrence identity and body
premises in `20261026-040010-ee608cb2729b`. the fixture then calls locator keys
on an inherited-editable child instead of the focused native host and fails its
focus assertion before typing. no product focus defect follows from that run.
the corrected driver keeps real click and immediate focus/caret assertions, sends
keys through the page keyboard, and retains all writing/release/retry oracles.
those latter arms remain unqualified.
