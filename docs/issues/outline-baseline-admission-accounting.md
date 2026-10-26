# occurrence baselines escape the session byte budget

`outlineController.ts::bytes` at `ec33256fa` charges unique canonical document
encodings plus history metadata, while `OutlineBinding.bind` independently
allocates a displayed ydoc for each occurrence. aliases of one large note can
therefore exceed the accepted 16 mib admission budget without increasing the
canonical-document count. retaining hidden history bindings makes their charge
necessary too. this is source evidence; no heap or capacity failure is claimed.

charge independent displayed/frozen baseline encodings through their existing
binding/pending owners, including prospective new aliases. retain the 64 distinct
document bound and protection of accepted writing/remote growth. release charges
only with actual owner release; visual placement anchors must not retain docs.

resolve with repeated large-note aliases: refuse new admission at the byte bound,
preserve accepted writing/focus, and admit again after inactive baselines/history
retire. qualify hidden undo/redo frontier preservation separately.
