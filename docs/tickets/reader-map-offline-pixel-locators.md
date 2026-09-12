# offline text reader estimates exact locators from scroll pixels

status: open
origin: 2026-09-11 reader-map implementation-spec review
area: offline text capture, restore, and progress

`apps/web/src/components/reader/TextDocumentReader.tsx:162-189` restores an
offset through a text-length/scroll-height fraction and publishes rounded
scroll fractions as canonical offsets.
`apps/web/src/offline-reading/OfflineDocumentReader.tsx:552-578`
supplies no-op intent callbacks and persists those positions as exact text
locators. uneven layout therefore changes the supposed source address; the
path also lacks the hosted reader's positioning-intent fence.

prerequisites: retain the existing canonical DOM offset/reveal contract when
sharing the corrected map with the offline renderer.

proposed fix: remove the proportional pixel/text conversion. share the hosted
text reader's canonical capture/reveal and positioning-intent primitives with
the offline text leaf; retain the existing native progress port.

acceptance: unequal paragraphs, images, reflow, and non-bmp text restore and
capture the same source locus in hosted/offline reading. programmatic restore,
preview, and return do not emit a reader-intent save or completion.
