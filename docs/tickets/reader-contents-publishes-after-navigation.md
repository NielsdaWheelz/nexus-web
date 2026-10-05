# reader contents publishes after the document read, briefly showing evidence

status: open · origin: 2026-09-24 reader-inspector-controls live verification; restated after the reader rewrite (pr2, 2026-10-05) · area: reader / inspector

reloading with the inspector open on Contents showed Evidence for ~120 ms
(desktop 332 -> 449 ms, mobile 299 -> 427 ms) before Contents, because the first
inspector publication lacked Contents. after pr2 the Contents body still exists
only once the reader's one read (`GET /media/{id}/reader`) has landed
(`MediaPaneBody.tsx`, the `contents` memo over `doc.toc`), so the host can
project its default tab first. not re-measured after the rewrite (source
reading only).

fix, if the flash matters: publish the media inspector only once the document
read is ready or failed, at the cost of showing the header Inspector control
later by the same interval.

acceptance: a reload open on Contents never paints Evidence.
