# palette-08 counts no link chips and expects the pair to filter

status: open · origin: 2026-11-02 palette s3/s4 repair · area: lab case (s0), `apps/web/.nexus-lab/cases/palette-08-rail.spec.ts:7,42,49-51` (ignored)

the case's `ITEM` is `:is(button, [role="menuitem"], [role="option"],
[role="button"])`. a resource row's `open` and `new pane` are link descriptors,
and the rail renders an enabled link descriptor as `<a href>`, as the menu does
(`NexusVerbRail.tsx:152`; the verb sheet: attributes mirror `ActionMenu`). so
on a book row the case counts only `more` until the read verbs settle (the
count runs as soon as the rail is visible; inferred), and `the rail holds verbs
plus more` (`:42`) fails.

the filter step (`:49-51`) then asks that every remaining item mention `new` or
be `more`. the verb sheet says "the pair is never filtered; `more` is last and
never filtered", so once `<a>` is counted, `open` remains after typing `new` and
`:51` fails against the sheet. today it passes only because `open` is invisible
to `ITEM`.

evidence: lab run `20261102-120048-554a7e7740c0`, palette-08 chromium: `the rail
holds verbs plus more / Expected: >= 2 / Received: 1`. the failure screenshot
shows the settled rail `open ↵ · new pane ⇧↵ · Add to Lectern · Chat about
this… · more`.

impact: criterion 8 is red before any of its product assertions run.

fix (case author, not the implementer): add `a[href]` to `ITEM`; in the filter
step, exempt the pair (`open`, `new pane`, `run`) as well as `more`, or assert
that the non-pair chips mention the filter.

resolved when palette-08's rail and filter steps (`:36-55`) pass in both
engines with `NexusVerbRail.tsx` unchanged. its last step, the unavailable
import, is `nexus-import-rail-holds-only-a-disabled-run.md`.
