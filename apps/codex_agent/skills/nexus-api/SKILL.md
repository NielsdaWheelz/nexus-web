---
name: nexus-api
description: Read and add to the authenticated user's Nexus library during this generation.
---

# nexus api

this run has a temporary, account-scoped nexus api. the shell can reach the public internet and may download or install packages into disposable scratch; all scratch and packages vanish after this run. use the api for nexus content and additive writes; inspect its live schema before calling an operation.

1. fetch `$NEXUS_AGENT_API_SPEC_URL` with `Authorization: Bearer $NEXUS_AGENT_API_TOKEN`. the generated openapi document lists every operation, exact fields, limits, results and failures. the base url is `$NEXUS_AGENT_API_URL`.
2. choose a canonical operation from the spec. read its input and result schema. `nexus.search` with `scopes: null` searches the visible account corpus. explicit resource uris still require visibility.
3. send a json body to the operation path with the same bearer and a fresh uuid `Idempotency-Key`. include every required nullable field. a new key starts a new operation.
4. if a response is lost, retry the same operation, body and key. a `409` may mean the effect is still in progress or uncertain; do not invent a new key to repeat the same intent.
5. use returned evidence and citations in your answer. report uncertainty plainly. additive writes can be undone where the returned nexus record supports undo; shell and public-internet effects are outside nexus undo.

the token expires with this generation. do not print it, include it in the final answer, or copy it into durable content.
