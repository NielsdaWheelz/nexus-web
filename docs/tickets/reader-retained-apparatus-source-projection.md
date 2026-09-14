status: open
origin: 2026-09-13 retained evidence implementation audit
area: publication source annotations / evidence

`reader_apparatus.py` updates existing item bodies, locators and source refs by
stable key (`item_update` around line 1896) and deletes absent items/edges during
replacement (`2037-2040`). the same apparatus UUID is therefore not immutable
source provenance. selected publication units retain marker attributes but no
frozen apparatus relationships. querying the current apparatus for an old
generation can show new source notes or lose the old source's sidebar facts.

prerequisite: agree the smallest retained authored-apparatus projection at the
existing publication preparation owner. retain existing item identity/stable key,
source selector and relationships; reference source ranges instead of duplicating
complete HTML/text where possible. live user associations/permissions remain
current. PDF sidecar bodies need explicit retained bounded access when no text
unit covers them. do not infer publication identity from a mutable apparatus UUID.

acceptance: replacing source apparatus while an older generation is open preserves
that generation's exact source reference/target facts and navigation; current
user associations are separately authorized. complete bounded traversal and
explicit target reads do not hydrate whole current documents or all annotations.
