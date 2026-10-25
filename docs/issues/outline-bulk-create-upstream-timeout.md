# bulk outline creation times out

problem: one public command request creating 100 note children returned 504
`E_UPSTREAM_TIMEOUT` before the partial-outline qualification reached its target
behavior. impact: a large batch cannot currently be relied on to acknowledge
within the browser gateway deadline; its commit outcome was not established.

evidence: isolated run `20261020-002050-403f2b967a12`, request
`febe356a-8d96-48c9-bc54-8ebc7aa0a04e`,
`POST /resource-graph/commands`, 100 `insert_note` commands with distinct
client-minted note/link ids and append positions. no underlying cause established.

partial-outline qualification uses smaller public batches to build the same
101-child destination. bulk throughput is outside this change.

availability qualification reproduced a related large-batch refusal in run
`20261025-141550-0161724be86b`: 105 `insert_note` commands against one page
returned 409 `E_RESOURCE_CONFLICT` (`Resource is busy; try again`), request
`2dce5fbb-f4d7-40df-9c6b-851fabee5f40`,
under normal disposable workers. availability fixtures use smaller public batches
to verify the same multi-page read; this does not qualify large-write capacity.
the same refusal also occurred for a 20-command fixture batch in run
`20261025-143314-ea1288a9aeeb`, request
`91de315c-7c04-49d2-a84f-887835431e49`. fixture setup may retry only that exact
busy response with the same client-minted ids; it must still obtain a real ack.

cause candidates (notes re-slice, 2026-10-21): each positioned insert reranks
the source's incident facts twice (`create_link`'s append, then `order.place`) and
every `_rank` rewrites each rank twice and bumps the lane
(`python/nexus/services/resource_graph/order.py:62-118`), so a k-item paste into an
n-item page writes O(k·n) rows in one serializable transaction. the batch no longer
reads every links version row of the viewer (the re-slice reads only the lanes it
checks), yet notes harness `api/A19` still answers 500 after ~3 s when three small
inserts into the same page run beside a 100-insert batch ("outline_commands exhausted
after 3 transaction attempts"): a genuine conflict on that page's lane and ranks.
owner: resource graph (`order.py`).

resolved when an isolated public 100-command request has an explicit successful
acknowledgement and durable result within its deadline, or the public batch limit
rejects unsupported sizes before executing. determine transaction outcome and
retry behavior before changing timeouts.
