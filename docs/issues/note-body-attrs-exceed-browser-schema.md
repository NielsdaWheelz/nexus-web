# server body attributes exceed the browser schema

`python/nexus/schemas/note_bodies.py:65-78,86-125` accepts attributes beyond
the listed requirements and returns the original json. browser `noteBody.ts:197`
parses it through prosemirror; the installed `computeAttrs` selects declared
attributes only. a valid
paragraph with `attrs: {external_hint: "keep"}` can therefore lose that field
when normalized in the browser and later saved. actual affected stored data has
not been inventoried.

review the shared body grammar before changing canonical equality: either own
the attribute explicitly or reject unsupported attributes at the canonical write
boundary, with a release data audit that refuses incompatible existing bodies.
do not silently normalize away accepted rich data or lazy-parse unknown bodies
to make two different raw values compare equal.

resolved when accepted canonical rich bodies retain their supported attributes
through read/edit/export/save, unsupported fields are refused before storage,
and existing incompatible rows require an explicit repair. source reproduction:
pass the paragraph above through validate_body, then browser parseBody and
compare the returned json; no production-data check has been run.
