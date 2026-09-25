# indexing without a credential is classified as a child defect

status: open · origin: 2026-09-24 reader-inspector-controls live verification, branch `reader-inspector-controls` · area: worker / search indexing

without an openai credential, `media_content_reindex_job` and
`note_reindex_job` fail as `E_WORKER_CHILD_DEFECT` ("CredentialMissing at
background child boundary") and retry to dead. the reader then shows "search
indexing stopped" and imports count it as needs-attention. a missing
configuration is reported as a code defect.

fix: classify a missing provider credential as a typed configuration
unavailability, not a child defect, and do not retry it as one.

acceptance: with the credential absent, the job records a configuration
failure once and the ui names the cause.
