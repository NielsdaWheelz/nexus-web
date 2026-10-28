# native x replacement captures change import identity

publishing a native x capture onto existing media changes its imports identity from
`media:<id>` to `upload:<session>`; further capture sessions produce additional
rows for the same media. this undermines recovery in place and can invalidate
an open original inspector. source-derived; no live reproduction.

evidence: native x capture can publish a fresh attempt onto existing media in
`python/nexus/services/media_upload_sessions.py:554-607`. imports emits every
upload session at `python/nexus/services/imports.py:205-210` and suppresses the
media ref whenever any session published it at `:211-215`. detail lookup at
`:437-447` requires the exact ref to remain in that projection.

reproduce: open a native x article's media import inspector, replace its
content with a bound extension capture, then reread the original ref and list;
repeat capture with another upload session.

web recovery now retains its original media import and groups bound capture
sessions into its pending state and history. this intentionally leaves native
x replacement behavior unchanged; its separate replacement contract still
needs a stable import identity.

define a stable imports identity for a native x replacement target. replacement uploads
belong to its history, not additional current obligations. preserve standalone
upload visibility where no target exists. resolved when repeated recovery
keeps one current row and a working original inspector, with every capture
attempt inspectable in history and accurate summary counts.
