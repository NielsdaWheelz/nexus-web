# reference rows draw their scheme glyph larger than the row anatomy

problem: the outline row anatomy asks reference rows for a 14px scheme glyph at a
1.5px stroke. `ResourceTypeIcon` draws every glyph at `--text-md` (16px) with
stroke 2 (`apps/web/src/components/resources/ResourceType.tsx`,
`ResourceType.module.css`), and the outline uses it unchanged; terminal rows'
`CornerLeftUp` is 14px at the default stroke.

impact: glyph markers outweigh the 6px note dot beside them; reference rows read
heavier than notes.

evidence: source reading in the presentation review (finding 15); the
presentation lane declared the gap and left it to the glyph lexicon work, which
owns glyph sizes. no case renders a reference row.

resolved when a reference row's glyph measures 14px with a 1.5px stroke inside the
outline, set by the glyph owner rather than an outline selector, or the anatomy is
amended to 16px.
