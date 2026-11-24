# observe editor revisions without reading rich projections

`WritingRuntime.listenDocument` subscribes to the full `resource`
projection. its callback uses only `store_revision`, then reads the
single canonical state that the editor actually needs.

the authenticated api-34 retained-work replay
`20261124-060233-fddaa76c8d5f` still observed two `resource` reads
after the row moved to its lean `work_row` proof. mounted editors keep
their separate watch in `apps/web/src/lib/notes/runtime.ts`. this
unnecessarily decodes the projected body on ordinary corpus changes.

use a revision notification for the editor's watch and keep its
current canonical read and retirement fence. verify in a paired app
that a remote edit reaches the same editor and the watch transfers no
rich projection. keep explicit menu reads independent.
