# oracle concordance has never rendered: its bff route was never added

status: open (decision needed) · origin: 2026-09-17 slop sweep (claude session)
· area: oracle concordance · oi-144

the whole feature exists except the proxy. `services/oracle.py:496-560`
(`compute_concordance`), `api/routes/oracle.py:83-92`
(`get_oracle_reading_concordance`), `services/resource_graph/citations.py:353-403`
(`concordant_sources`), `schemas/oracle.py:450-459` (`ConcordanceEntryOut`),
`OracleConcordance.tsx` and `AtlasConcordancePeerLoader.tsx` are all present and
both browser consumers fetch `/api/oracle/readings/${id}/concordance`
(`OracleConcordance.tsx:76`, `AtlasConcordancePeerLoader.tsx:24`). that BFF
route file does not exist: `find apps/web/src/app/api/oracle -type f` returns
`corpus/route.ts`, `readings/route.ts`, `readings/[id]/route.ts` and
`plates/[id]/route.ts` only; there is no catch-all under `app/api` except
`media/[id]/assets/[...assetKey]`, `middleware.ts` proxies nothing and
`next.config.ts` has no rewrites.

`ApiPath` is `/api/${string}` (`lib/api/client.ts:13`), so the gap is not a type
error — it is a runtime 404, and both components render null on a non-ready
result (`OracleConcordance.tsx:79-80`), so the failure is invisible. `git log
--all --diff-filter=D` on that path is empty: the route never existed.
`docs/modules/oracle.md:108-112` nevertheless specifies concordance as a module
contract.

decision: repair or delete. repair is one 12-line proxy route; delete is roughly
330 lines across python and web.

prerequisite: the owner's answer.

fix: to repair, add `apps/web/src/app/api/oracle/readings/[id]/concordance/route.ts`
as a copy of `readings/[id]/route.ts` proxying
`/oracle/readings/${id}/concordance`, then look at the rendered pane. to delete,
cut `compute_concordance`, the FastAPI route, `concordant_sources` and its
`ConcordantSource` result type, `ConcordanceEntryOut`, `OracleConcordance.tsx`
and its call site (`OracleReadingPaneBody.tsx:752`),
`AtlasConcordancePeerLoader.tsx` and its call site
(`GrandAtlasPaneBody.tsx:782`), the `.concordance*` block in `oracle.module.css`
(766-828), and the concordance paragraph at `docs/modules/oracle.md:108-112`.

acceptance: either an oracle reading pane shows concordance entries against real
data, or no concordance symbol remains in python or web and the module doc no
longer promises one.
