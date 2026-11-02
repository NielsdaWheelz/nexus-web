# five media absorbs the glyph lexicon

the five media spec names lucide drawings directly. the lexicon now owns every
drawing, and an export is paid for by a bare use, so `Book`, `Episode` and `Video`
are not on main yet. when five media merges main:

- it adds `export const Book: Glyph = BookOpen;`, `Episode` (`AudioLines`) and
  `Video` (`Video`) to `apps/web/src/lib/ui/icons.tsx`, one per line with their
  glosses: a bound work, a recording you hear, a recording you watch.
- `lib/media/kind.ts` and `lib/resources/type.ts` reach every sign through
  `import * as Icon` (`Icon.Book`, `Icon.WebText`, `Icon.Page`, `Icon.Episode`,
  `Icon.Video`), never `lucide-react`, which eslint refuses there.
- lexicon decision 6 overrides three of its lines: a page draws `Page`
  (`FileText`), not `File`; a podcast draws `Podcast`, not `Disc3`; passage schemes
  draw `Passage` (`Quote`), not `TextQuote`. its "`visual-system.md:317-319`
  stands" no longer holds: that paragraph now routes lucide through the registry.
- its popup import scan reruns on the merged tree.

resolved when five media merges with `bun run lint:icons`, `--check-swept` and
`./scripts/test` passing and the three exports in the registry.
