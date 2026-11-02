# the first open after load paints tab rows without bylines for ~200ms

status: repaired, browser verification pending · origin: 2026-11-02 palette s3 lab · area: web / workspace presentations (s2)

criterion 10 wants every remote pane's byline in the palette's first frame. on a
fresh page the strip shows titles from the catalog (`presentations.tsx`, the
`saved` branch returns `detail: null`) until the canonical facts read lands; the
held-facts repair (be48f886b) keeps a *previous* ready map across a re-key, so it
cannot cover an open that comes before the first read settles.

evidence: lab run `20261102-120048-554a7e7740c0` (tree bdc4ea307), palette-10
chromium: first frame `["here. Moby-Dick; or, The Whale","Sir Gawain and the
Green Knight","The Garden of Forking Paths",…]`, 13 frames (~200ms) without
`Herman Melville` etc., then bylines. the names come from `rowFacts` /
`paneCandidateName` over `presentation.detail`, unchanged by s3. s2's run
20261102-102236 had chromium green on this test, so the gap is timing (inferred).

impact: the byline appears ~200ms after open on the first open of a session; the
row's second line appears then (36px → 52px), moving the rows below it.

fix: the catalog branch of `forVisit` carries the catalog's contributors as the
byline, so a title known before the canonical read already has its facts.

repair: the account presentation read now revalidates its stable key through
`stale`, retaining facts in the existing read owner without a render-mutated ref.
the catalog media branch supplies contributor bylines alongside its title.

resolved when: palette-10's first-frame byline test and palette-07's synchronous
latch journey pass in both engines on the repaired source; a cold device without
catalog or canonical facts must still expose its actual loading state.
