# companion density draws from the glyph lexicon

`docs/companion-density-spec.md:177-178` adds `FILTER_ICONS: Record<Filter,
LucideIcon>` in `model.ts` with `Highlighter`, `NotebookTabs`, `Link` and
`Glasses`, a new lucide importer for playback lane 8 to sweep. the lexicon has
swept, lane 8 is retired, and eslint refuses `lucide-react` outside the registry.
when companion density is built:

- `FILTER_ICONS` types `Icon.Glyph` and reads `Icon.Highlight`,
  `Icon.SourceReference` and `Icon.Link`.
- `Glasses` has no sign. the librarian facet takes a new sign from the
  iconographer, added to `apps/web/src/lib/ui/icons.tsx` with its gloss, or paints
  nothing, which makes the record `Icon.Glyph | null` and leaves that facet its
  visible word: an icon-only control needs a sign.

resolved when companion density merges with `--check-swept` and `./scripts/test`
passing and the librarian facet's sign ruled.
