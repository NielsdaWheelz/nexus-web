# tool search embedding cancellation needs qualification

status: open; the historical thread-ownership defect is repaired in source;
targeted delayed-provider cancellation proof remains required.

at `c0acf77c3`, strict retrieval started `asyncio.to_thread(embed_text, ...)`
before consulting the tool's absolute deadline. the background adapter owned a
separate retry loop, so cancelling the awaiting tool could leave provider work
running. the original paths, impact and proposed repair remain private in
`.nexus-local/pr866-e219-doc-contract-before.private/81f/docs/issues/tool-search-embedding-outlives-deadline.md`.

the integrated candidate awaits native `embed_texts_async` inside the caller's
existing absolute deadline and uses one query-provider attempt. requested semantic
unavailability remains an explicit modeled failure; it does not silently fall
back to lexical success. background indexing retains its own provider policy.

resolve when a deliberately delayed provider is cancelled by tool stop/deadline,
no later retry or database statement starts, and the tool receipt settles once.
ordinary useful retrieval and its expected provider-failure outcome must remain
correct. use the existing isolated runtime, not production; this record does not
claim that qualification ran. no second timer or cancellation owner is needed.
