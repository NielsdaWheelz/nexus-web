# epub navigation intervals cannot represent chapter extents

status: open
origin: 2026-09-11 reader structure audit
area: epub section extent model

## evidence

`python/nexus/services/epub_ingest.py:2599-2610` ends each navigation target at
the next distinct target in the same fragment, or at that fragment's end. it
does not use toc ancestry. `python/nexus/schemas/media.py:911-925` supplies
one fragment id for both offsets. a parent chapter therefore ends at its
first nested heading; a chapter spanning multiple xhtml files cannot be
represented. existing documentation explicitly defines these as targets,
not lengths (`docs/modules/reader-implementation.md:382-385`).

this is a representation gap against the requested semantic chapter/heading
lengths, not evidence that current unique-fragment document totals are wrong.

## prerequisites and fix

define whether a section includes descendants and separate that semantic
extent from the disjoint intervals drawn between adjacent boundary nodes.
represent semantic starts and ends as document locators capable of crossing
fragments. preserve heading ancestry and compute a parent's end from its next
peer/ancestor boundary or document end. derive disjoint display intervals
from the selected outline depth without counting children twice.

## acceptance

fixtures with nested headings, distinct parent/child extents at one start,
pre-heading/interstitial/trailing content, and chapters spanning files have
correct semantic extents. interval-end ticks preserve uncovered spans without
mislabeling them as chapters. each
display level covers its declared document range once; local progression and
edge lengths use that same range and measure.
