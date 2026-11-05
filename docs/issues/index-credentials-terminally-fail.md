# index credentials need repair

the three indexing handlers still return `TerminalJobFailure` for
`CredentialMissing`, after publishing reusable lexical text. missing configuration
therefore runs destructive terminal hooks and cannot resume the same job through
the held repair path.

evidence: the credential branches in `services/content_indexing.py`,
`services/authored_text_indexing.py` and `tasks/x_capture_content_reindex.py` return
`E_EMBEDDING_NOT_CONFIGURED` as a terminal. the recovery contract classifies invalid
setup as held, preserving checkpoints.

resolution: raise typed `JobFailure(..., disposition='hold')` in all three owners.
prove lexical ids/revision remain published and unchanged, the queue holds without
on-dead effects, and a reviewed repair resumes semantics from that checkpoint.
