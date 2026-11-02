# local-first branches rerun the glyph codemod

`codex/local-first-writing` and `codex/local-first-current-main` were cut before
the glyph lexicon. files they rewrote still import `lucide-react`, which eslint now
refuses outside `apps/web/src/lib/ui/icons.tsx`.

on rebase, each conflicted file keeps the branch's body, then, from `apps/web`,
with the sweep and map attached to the lexicon pr as its first comments:

1. `bun sweep.ts --rows-since <the lexicon pr's base> --paths <its files>` prints
   fresh rows; paste them into the map and fill each sign from the lexicon table
   (a drawing it does not name needs the iconographer). drop rows for files the
   branch deleted; `--check-map` names them.
2. `bun sweep.ts --map <map> --paths <its files>` sweeps; its refusals are the
   by-hand list (`Disclose`, words on icon-only controls).
3. `bun sweep.ts --check-swept` over all of `src` passes.

resolved when each branch's tip passes `--check-swept` and `./scripts/test`.
