# epub sequential navigation follows toc order within a file

status: open
origin: 2026-09-11 reader structure audit
area: epub navigation order

## evidence

`python/nexus/services/epub_ingest.py:2545-2566` assigns section ordinals in
publisher toc order inside each fragment. the existing accepted fixture
`python/tests/service/test_epub_structural_anchors.py:184-194` deliberately
retains a later target before the chapter start and earlier targets.

`python/nexus/services/epub_read.py:363-364` derives previous/next ids by this
ordinal. `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:4555-4572`
also derives the previous/next controls from that section array, and
`:5950-5979` activates them. next can therefore move backward in the text.

## prerequisites and fix

keep publisher toc presentation order distinct from canonical reading order.
derive sequential previous/next targets from ordered unique
`(fragment_idx, start_offset)` locations. preserve publisher nesting/labels
without making duplicate aliases extra reading steps.

## acceptance

the existing out-of-order fixture retains its authored outline while repeated
next navigation progresses monotonically through canonical text; previous
reverses that sequence. duplicate aliases do not create repeated steps.
