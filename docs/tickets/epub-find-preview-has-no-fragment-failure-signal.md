# epub find preview has no fragment failure signal

status: open; accepted trade-off · origin: 2026-09-24 reader-inspector-controls live verification, branch `reader-inspector-controls` · area: reader find

`waitForRenderedFragment` (`app/(authenticated)/media/[id]/useEpubPaneFind.ts`)
has no frame deadline: it ends when the fragment renders, the request aborts,
or its override is superseded. a frame budget misjudged slow highlight reads
and hidden pages (which deliver no frames) as defects and crashed the pane. the
cost: if the reader fails to load the preview fragment, the preview stays
pending behind the reader's own error until find is dismissed.

fix: the reader publishes a terminal fragment-load failure that the find wait
observes and reports as a typed find failure.

acceptance: a preview of a fragment whose load fails ends with a find error
instead of pending.
