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

resolved when an isolated public 100-command request has an explicit successful
acknowledgement and durable result within its deadline, or the public batch limit
rejects unsupported sizes before executing. determine transaction outcome and
retry behavior before changing timeouts.
