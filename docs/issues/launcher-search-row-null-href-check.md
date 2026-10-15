# launcher search rows keep a dead null-href check

**problem**: the Nexus launcher skips a search row when `activation.href === null`, but the
search view model already drops such rows and narrows `activation.href` to `string`, so the
check can never be true.

**impact**: none at runtime; one dead condition in a file the search pane reauthor may not
edit (its boundary stops at `lib/search/*`).

**evidence**: `apps/web/src/lib/nexus/rows.ts:278`
(`if (result.activation.kind !== "route" || href === null) return [];`) against
`apps/web/src/lib/search/searchViewModel.ts:136-143`, which returns no row for a null href and
spreads a non-null `href` into `activation`.

**resolved when**: the next change to `lib/nexus/rows.ts` drops `|| href === null`, and
`bun run typecheck` still passes.
