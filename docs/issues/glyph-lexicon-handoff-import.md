# import slices 2 and 3 draw from the glyph lexicon

`docs/import-spec.md:35` gates slice 2 on direct lucide `ArrowLeft` and `Import`,
for playback lane 2 to sweep. the lexicon has swept, lane 8 is retired, and eslint
now refuses `lucide-react` outside `apps/web/src/lib/ui/icons.tsx`. when slices 2
and 3 are built:

- new files draw through `import * as Icon from "@/lib/ui/icons"`.
- a back control is `Icon.Left`, a chevron, as the add panel's back arrow from
  #887 now is.
- an import meaning takes `Icon.Upload` (bring it in), as the palette's `import`
  and the imports route do, or a new sign from the iconographer; lucide's `Import`
  is not in the lexicon.

resolved when slices 2 and 3 merge with `--check-swept` and `./scripts/test`
passing.
