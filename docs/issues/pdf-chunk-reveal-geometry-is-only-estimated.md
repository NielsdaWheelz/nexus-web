# pdf chunk reveal geometry is only estimated

source baseline: `69c00182c8328f46cec893517971f87f03cdbf16`; still present at `origin/main` `ff57128842b470510446b3edca54922ebcace41e` on 2026-10-16. line numbers refer to the original baseline unless stated otherwise.

status: open
origin: 2026-10-16 resource presentation architecture audit
area: content indexing / pdf source activation

problem: a pdf chunk's stored geometry can be a thin estimated band rather than
the quoted text's extent. the reader target drops that precision distinction.
painting every returned quad as an exact source selection would misrepresent
what was cited, even after transient pdf decoration is implemented.

evidence: `python/nexus/services/content_chunking.py:189-211` computes a band
from the chunk's proportional text offset and labels its projection
`proportional_text_offsets`. `services/locator_resolver.py:432-438` under the
same package exports the quads without that projection; the final reader target
at `services/resource_graph/reader_targets.py:173-175` retains page and quads
only. source trace; no live pdf reproduction was run.

prerequisite: distinguish exact text geometry, approximate position and page-only
location in the source target contract.

proposed fix: map the canonical quoted extent to the current pdf text layer where
an exact correspondence is available. preserve approximation explicitly when it
is not; show the page and quote without claiming an exact marked range. use the
existing pdf geometry owner rather than a second positioning implementation.

acceptance: chunk reveals on a multi-column pdf mark the actual quoted text when
resolved. approximate bands and page-only targets are identified as such and
cannot appear as exact passage highlights.
