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
found in full search. provider billing still requires owner repair.

2026-10-28: contained-work bibliography qualification reproduced the same 402
through the actual metadata worker in isolated run
`20261028-101320-f9b386f5f80a`. the queue ended with
`E_WORKER_HANDLER_FAILED` and no result. the contained-work change fixes the
shared provider classification and pins its consumers together: search now records
`UpstreamUnavailable`, and research can complete from saved evidence without
inventing unsupported facts. three real-source runs exercised that behavior in
`20261028-104217-6216244b52d3`. this resolves the worker crash, not the external
billing failure or successful public-search qualification. activation follows
[the paired release](release-contained-work-metadata.md).
