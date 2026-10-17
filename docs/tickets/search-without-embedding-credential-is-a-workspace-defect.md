# search without an embedding credential becomes a workspace defect

status: open · origin: 2026-10-16 principal-actions qualification · area: search / provider failures

an ordinary nexus query without the backend openai credential returns 500 and replaces the workspace with its defect screen. this is a missing configuration, not an unexpected programming failure.

evidence: `python/nexus/services/search/service.py:100` calls embedding without translating its known refusal; `python/nexus/services/embeddings.py:59` raises `CredentialMissing`. isolated real request `b1b364db-0726-466a-ae11-998a54006787`, 2026-10-17 01:19:07 utc, `get /search`, failed with `CredentialMissing: no openai credential configured`. the browser reported `ApiError: Internal server error` from `fetchSearchResultPage`, caught by the workspace boundary. no credential values were read or printed.

fix: model the known missing-provider configuration at the search owner and return its typed unavailable response; preserve defect handling for unexpected failures. no silent lexical fallback. the broader policy for actual retrieval defects is already recorded in `nexus-retrieval-defects-replace-the-workspace.md`.

acceptance: with no embedding credential, a real query shows the modeled unavailable state without destroying the workspace; with a valid credential, the same query works. this is separate from the worker indexing classification ticket.
