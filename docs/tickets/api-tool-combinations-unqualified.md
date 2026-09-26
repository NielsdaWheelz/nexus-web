# api tool-bearing generation combinations are unqualified

status: open  
origin: 2026-09-25 chat reliability adversarial review  
area: provider api qualification

the pinned provider-runtime `7008b669` returns `unqualified` for API text
plus model tools and `unsupported` for strict-json plus tools. source
compatibility is not a completed provider/tool/effect proof. no generation API
credentials are configured in the available local worktree, so a real
tool-bearing chat turn cannot be qualified here. `generation_catalog.py`
therefore marks API tool-bearing selections ineligible before admission. the
strict-json plus tools cell is rejected by the provider library before i/o.

first qualify each offered route/model/reasoning/output/tool combination on
the exact provider-runtime and kernel pins, including one real authorized
tool round trip, durable receipt, final answer and replay without duplicate
effects. the library must then expose a positive qualified combination fact;
the catalog, admission and pre-dispatch owners consume it together. do not
promote `unqualified` to a runtime permission or silently omit the tool plan.

resolved when each offered API chat cell has exact-pin positive and negative
effect evidence, the library contract distinguishes it from unqualified and
unsupported cells, and new/continued chat completes through that route with
leave/reopen recovery.
