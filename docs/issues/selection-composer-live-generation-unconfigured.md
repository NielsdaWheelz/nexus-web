# real quoted-chat generation needs a local runtime

status: open · origin: 2026-10-15 selection composer qualification · area: reader / chat verification

task-local `/llm-catalog` and `/chat-runs` returned
`503 E_GENERATION_RUNTIME_UNAVAILABLE`. refusal and exact-retry observations do
not establish accepted conversation creation, quote provenance or terminal delivery.
qualification: #631.

a task generation host was prepared but never started; it did not acquire or
refresh the existing shared local codex login. pr cleanup removed the unused
preparation and isolated fixtures. no production account was copied or changed.

prerequisite: a working isolated generation runtime with an authorized local
account; see the [runbook](../runbooks/codex-personal-agent-host.md). use ordinary
catalog/admission, no provider-success substitution.

acceptance: one or two tiny real runs prove the submitted first prompt, canonical
quote/revision, accepted conversation/run and terminal delivery. annotation
body/version and unrelated chat draft remain unchanged. lose an accepted response
and retry identical key/bytes while the tab lives; no reload recovery is promised.
remove disposable fixtures and stop only owned services after evidence is recorded.
