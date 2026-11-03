# embed-annotated rows grow at rest

problem: in the connections-scroll lab, two highlight rows whose annotations embed another highlight sometimes measure
far taller at rest than at first commit. it is intermittent. it is not tied to run order, as first thought.

impact: a2 chromium (first commit at rest height) fails when it happens. if the cause is in the product, an embed can
grow after mount, which moves rows below it in `all`. idk whether it is product or suite. whenever row 268 grows, its
census `marks` hold 369 characters against its quote's 286 (286 when it does not), so the growth is extra marked
content, and an embed's content arriving late is the first suspect (the spec lets embeds fetch: "exceptions to C1").

evidence, stress book, chromium census at rest against first commits of the v800 passes:

| run | order | row 268 (embeds 203) | row 274 (embeds 59) | a2 chromium |
| --- | --- | --- | --- | --- |
| `l4-g3` `20261102-153701-ce1a8a31b1d4` | a10 a11 a4 | 323 first, 866 rest | 155 first, 1202 rest | fail, 8 mounts |
| `l4-g4` `20261102-155105-fc2540d8f0f7` | a4 a10 a11 | 323, 323 | 155, 155 | pass |
| `l4-final` `20261102-160331-ddfe7c86f359` | a4 a10 a11 | 323, 323 | 155, 155 | pass |
| `l4-fix` `20261102-165129-60070ab57b87` | a4 a10 a11 | 323 first, 866 rest (cold down, cold up) | 155, 155 | fail, 2 mounts |

the embedded rows 203 and 59 measure the same throughout (98, 683). `l4-fix` changed only margin paths from
`l4-final`, none of which run in `all`. all runs 2026-11-02, branch `connections-scroll`.

reproduce: `./scripts/lab -- bash apps/web/.nexus-lab/cases/run.sh <label> a4`, then read a2 chromium; repeat, since it
is intermittent.

resolved when a2 chromium passes in several consecutive runs with the embed rows' first commit equal to rest, or the
growth is traced to the suite.
