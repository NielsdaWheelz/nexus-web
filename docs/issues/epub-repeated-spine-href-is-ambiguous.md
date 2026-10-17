# repeated epub spine hrefs are ambiguous

status: open; outside the 57-book repair set, with no occurrence established
origin: 2026-10-16 package-navigation implementation, base `f4026846`
area: epub source correspondence

`services/epub_ingest.py` builds `href_to_frag_idx` with `setdefault`, retaining
the first fragment for a repeated package href. `services/epub_structure.py`
builds `by_href` with a dictionary comprehension, retaining the last. the two
owners can therefore resolve one publisher target to different copies of a
repeated spine document.

use one explicit rule for ambiguous package correspondence: refuse it, or keep
it non-navigable through both owners. preserve readable source content. resolution
requires a repeated-spine fixture proving consistent contents/section targets and
that no saved position or retained fragment changes. no production case or repair
is authorized by this finding.
