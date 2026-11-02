# palette-02's antisymmetry assertion cannot pass for any comparator

status: open · origin: 2026-11-02 palette s2 repair · area: lab case (s0), `apps/web/.nexus-lab/cases/palette-02-rank.spec.ts:41-43` (ignored)

the criterion-2 case iterates `for (const a of fixture) for (const b of fixture)`
and asserts `expect(Math.sign(compareRank(a, b))).toBe(-Math.sign(compareRank(b, a)))`.
when `b === a` the comparator returns `0` (line 42 demands exactly `+0`), so the
assertion reads `expect(0).toBe(-0)`; `toBe` is `Object.is`, and
`Object.is(0, -0)` is false. the first pair tried is `(fixture[0], fixture[0])`,
so the test fails on its first iteration whatever `rank.ts` does.

evidence: lab runs `20261101-235405-493d47cab729` (baseline) and
`20261102-102236-9ed98197f184` (tree `dc938ed0e`), both:
`Expected: -0 / Received: 0` at `palette-02-rank.spec.ts:43`. by reading,
`compareRank` (`apps/web/src/lib/nexus/rank.ts:18-24`) is total over the
fixture: tier, frecency, recency, stream, then key, and every fixture key is
distinct, so no distinct pair compares equal.

impact: criterion 2's determinism-and-totality proof is red for a reason that is
not the product; the two sibling tests in the file (name tiers, latching) pass.

fix (case author, not the implementer): compare signs numerically, e.g.
`expect(Math.sign(x) + Math.sign(y)).toBe(0)`, or skip `b === a`.

resolved when palette-02's first test passes on a tree where `rank.ts` is
unchanged.
