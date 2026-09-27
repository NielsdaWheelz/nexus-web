# generic pane find live acceptance blocked

status: blocked; origin: 2026-09-26 reversible reader navigation acceptance; area: conversation/artifact find

the isolated account has zero chats. `/conversations/new` reports “model availability could not be loaded,” `/api/llm-catalog` returned http 503 after renewed login, and send is disabled. `python/nexus/services/generation_catalog.py` requests the codex host model catalog before constructing provider routes; the isolated api has no override for its default `/run/nexus-codex/agent.sock`, which does not exist on this mac. the embeddings key cannot supply that service. `/atlas` exposed only media stars; no dossier artifact was available. conversation and artifact find therefore remain `NOT_RUN`, not failed.

prerequisite: run an authenticated codex host through its normal sandbox/egress boundary, then create one ordinary chat and dossier artifact through product flows. acceptance: search a known term in both panes, step to a result, close find, and verify the original position returns without a 4xx/5xx response.

the owner confirmed on 2026-09-26 that no authenticated test host is available for this acceptance run.
