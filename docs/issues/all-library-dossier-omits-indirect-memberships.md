# all library dossier omits media held through named libraries

the all library dossier expands physical entries in the supplied default
library only. all's canonical content set also includes direct media from the
viewer's other non-system library memberships, so the dossier can omit readable
content held solely there.

evidence: `python/nexus/services/dossier/inputs.py:300-322` expands entries by
the supplied library id; `python/nexus/services/library_entries.py:103-117`
defines all across non-system memberships. source-derived.

resolve in dossier composition using canonical all membership and an explicit
stable ordering. do not change authorization or lifetime rules. this remains
separate from the named-library podcast inheritance repair.

acceptance: a readable item held only in a named non-system library appears in
all's dossier input; duplicates collapse, inaccessible/deleted items stay out,
and the chosen ordering is deterministic.
