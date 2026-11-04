# authored inline image height is not reserved

status: source-level gap; delayed-image behavior has not been measured.

`node/authored/src/body.ts:64–68` serializes an authored image with only `src`,
`alt` and `title`; `:320` rejects dimension attributes. `NoteEditor` uses that
ordinary image serializer, and `NoteEditor.module.css` reserves no image box.
an uncached image can therefore acquire intrinsic height after its annotation
mounts. remembered row height protects a later remount, not the first image load.

the connections-scroll corpus exercises rich text, tables and resource embeds,
but does not establish first-commit height for an inline image. do not infer that
coverage from its a2 result. this also affects ordinary note surfaces.

resolved when a delayed-image case establishes first-sight and remount behavior,
and image presentation reserves its intended extent or the owner explicitly
defines this asynchronous boundary. a schema change is not implied by this record.
