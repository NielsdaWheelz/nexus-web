# native x replacement captures change import identity

publishing a native x capture onto existing media changes its imports identity from
`media:<id>` to `upload:<session>`; further capture sessions produce additional
rows for the same media. this undermines recovery in place and can invalidate
an open original inspector. source-derived; no live reproduction.

evidence: `python/nexus/services/media_upload_sessions.py::confirm_session` admits a
fresh attempt on a bound native x target. the `import_refs` relation in
`python/nexus/services/imports.py:225` emits non-web-recovery upload sessions
and suppresses their published media refs at `:230`. `read_import_detail`
requires the exact ref to remain in that projection.

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
