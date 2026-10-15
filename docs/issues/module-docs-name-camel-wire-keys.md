# module docs still name camelCase wire keys

**problem**: the wire sweep made every api key snake_case, but module docs written against the
camelCase wire still spell some keys that way (e.g. `nextCursor`, `mediaSummary`,
`clientMutationId`, `positionMs`, `activeSurfaceId`). some of those names are still right:
the web's internal view models, the web↔apk bridge ops and the preview descriptor stay
camelCase, so the docs need a read, not a blind rename.

**impact**: a reader of a module doc can send or expect a key the api now refuses or never
sends.

**evidence**: `grep -rnE '\b(nextCursor|mediaSummary|clientMutationId|positionMs|activeSurfaceId|resetEpoch|playerDescriptor)\b' docs/modules docs/architecture.md`
at the sweep commit: player.md (31), workspace.md (14), consumption-activity.md (9),
architecture.md (9), offline.md (8), contributors.md, podcast.md, library.md (6-7 each).
the sweep corrected only the lines that described the Presence encoding or the camel
serialization itself.

**resolved when**: every wire key in docs/modules and docs/architecture.md is the snake_case
key the api sends, and every camelCase name left names an internal web or bridge value (the
architecture rewrite at the end of the campaign may absorb this).
