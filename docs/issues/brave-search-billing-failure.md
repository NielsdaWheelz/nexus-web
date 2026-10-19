# brave search billing blocks live web retrieval

problem: the configured brave search credential receives http 402. this is an
external provider/binding issue, outside the browser search change. no real web
snapshot fixture can be created through `web.search` while it persists.
the owner confirmed that the monthly quota is exhausted and authorized skipping
only this provider-dependent live fixture. no bypass or substitute provider
response is part of that exception.

evidence (2026-10-19): an actual isolated chat job dispatched `web.search` through
`python/nexus/services/tools/run.py:run_tool` with the ordinary configured binding. brave
returned `402 Payment Required` from `/res/v1/web/search`;
`llm_tools/web/tools.py:176` then raised
`RuntimeError("configured Brave binding violated host policy")`. the generation
was closed and its worker resumed. no provider response was substituted.

restore the credential's provider quota, then repeat a real
dispatcher call and verify that its saved external snapshot can be reopened and
found in full search. separately decide whether this provider billing response
should be an expected typed tool failure instead of a host-policy exception;
that belongs to the shared `llm_tools` provider/binding owner.
