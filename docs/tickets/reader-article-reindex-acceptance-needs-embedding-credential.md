# article repair reindex acceptance needs an embedding credential

status: open
origin: 2026-09-26 reader chapter repair acceptance, isolated local stack
area: reader navigation / content indexing verification

the disposable article `01a0e084-6412-7762-b29a-f410a72705d6` was
repaired at reader publication generation 2. published navigation now contains
only the authored `A short chapter` and `Notes` sections. its reconciliation
index revision 2 job `02444e86-ac04-4fe7-a8ce-b7734787a3e7` failed on its
first exact worker run with `CredentialMissing: no openai credential configured`
(`E_WORKER_HANDLER_FAILED`). the index remains `indexing`; revised indexed
section metadata has not been published (`content_blocks` has zero rows for the
article). this is an isolated acceptance blocker,
not evidence of a repair defect or a production failure.

prerequisite: configure an embedding credential in the isolated stack. retry
the exact failed job through the normal worker path; do not alter production.

acceptance: job succeeds for revision 2, index state becomes ready, and retrieved
content blocks for this article reflect the repaired two-section navigation.
