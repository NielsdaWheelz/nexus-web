# writing journal cannot initialize

`95e4b8fa3` live browser trace reports `SyntaxError: Failed to execute 'createIndex'
on 'IDBObjectStore': The keyPath argument contains an invalid key path.` the
upgrade fails before the first local checkpoint; writing correctly reports
memory-only but cannot become durable.

evidence: private run `20261021-123239-bd39abe2935d`, first durable-browser case,
`journal.ts` database upgrade handler. fix the closed envelope/index contract at
that owner, without a storage fallback. resolved when a fresh database opens and
the exact completed offline rich checkpoint survives browser-process restart.

source repair uses a derived envelope-level branch key with a valid compound
index; no duplicate domain field or fallback. fresh-database/restart qualification
remains pending.
