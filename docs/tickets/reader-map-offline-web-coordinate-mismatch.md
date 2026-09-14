# offline web navigation emits document offsets as fragment offsets

status: open
origin: 2026-09-11 reader-map council audit
area: offline reader navigation contract

`apps/web/src/lib/reader/DocumentReaderSession.ts:204` sums preceding fragments, then places that sum in section `start_offset` and adds fragment length for `end_offset` (`:219`). `ReaderNavigation` uses fragment-relative offsets: its normal decoder rejects values beyond that fragment's canonical length (`apps/web/src/lib/media/readerNavigation.ts:166`). the offline adapter feeds this branch (`apps/web/src/lib/offlineReading/OfflineReaderAdapters.ts:110`) and the session returns the constructed navigation without decoding it. e.g. fragments of lengths 100 and 20 produce second-fragment section offsets `[100,120]` rather than `[0,20]`.

prerequisites: retain the shared fragment-relative navigation contract when extending map presentation to the offline reader.

proposed fix: produce fragment-local bounds directly and preserve canonical heading targets in the offline navigation payload when section mapping is added. global prefix sums belong solely in document projection.

acceptance: a multi-fragment offline web fixture satisfies the same navigation contract as hosted reading; projecting each section start adds its fragment prefix exactly once; chapter targets and progress remain correct across uneven fragment sizes.
