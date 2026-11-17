# reference glyph size differs from the outline anatomy

deferred visual polish; current shared sizing is acceptable for the prototype.
this was a source finding, not a rendered reference-row case.

the outline anatomy calls for a 14px scheme glyph. `ResourceTypeIcon` uses
`--text-md` (16px) through
`apps/web/src/components/resources/ResourceType.module.css` `.icon`, while
terminal rows use a 14px `Icon.Locate` in `OutlineEditorRow.tsx`. the shared
1.5px non-scaling stroke in `globals.css` already satisfies the stroke rule.

impact: reference markers can read heavier than the adjacent note dots.

resolved when: the glyph owner provides the intended outline size, or the row
anatomy explicitly accepts the shared 16px size. avoid a private outline glyph
variant merely to settle this cosmetic difference.
