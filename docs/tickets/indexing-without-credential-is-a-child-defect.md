# missing embedding credentials are classified as internal defects

status: open · origin: 2026-09-24 reader-inspector-controls; extended 2026-10-15 toolbar qualification · area: worker / search configuration

without an openai credential, `media_content_reindex_job` (documents and, since
the 2026-10-10 content index reauthor, transcripts) and `note_reindex_job` fail as
`E_WORKER_HANDLER_FAILED` ("CredentialMissing: no openai credential configured";
since the 2026-10-10 jobs reauthor one `failure_of` classifies both lanes) and
retry to dead. the reader then shows "search indexing stopped" and imports count
it as needs-attention. a missing configuration is reported as a code defect.
(the transcript kind's reconciler loop that re-admitted such a dead index every
tick is gone: a dead revision stays dead until RepairSearch or a new request.)

fix: classify a missing provider credential as a typed configuration
unavailability, not a child defect, and do not retry it as one.

acceptance: with the credential absent, the job records a configuration
failure once and the ui names the cause.

additional evidence, 2026-10-15 toolbar qualification: ordinary media search
through `/api/search` returns 500 `E_INTERNAL` without an openai credential,
including `q=toolbar` with imported lexical matches. `services/embeddings.py:60`
raises `CredentialMissing`; `services/search/semantic.py:34` handles only
`NonGenerationCallFailed`. both paths are under `python/nexus/`. this is the
same missing-configuration classification gap at an interactive boundary.
provider-free `kind:people` queries remain available for toolbar timing proof.

extend acceptance: missing embedding configuration also produces an explicit
modeled outcome at the search boundary, rather than an internal-error response.
