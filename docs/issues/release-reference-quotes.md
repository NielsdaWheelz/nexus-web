# release reference quotes

pair api, web, android and extension assets through the canonical release owner.
wire remains 23: the installed web manifest and public api `/version` name
`c828088a2e97`, whose source declares wire 21/schema 0341; pending 23 has not shipped. recheck the installed
release before merging if another deployment intervenes. retain authored replicas
and pending writing; no authored format changes.

migration 0344 follows 0343. it adds explicit `quote: null` to saved attachments
and resource retrieval targets, strips message locators and freezes no words.
unparseable references abort migration. stop all application writers, establish a
verified backup, migrate once and verify the exact head before paired startup.
there is no downgrade or old-wire reader; recovery restores the paired release and
its verified backup.

with new code deployed and writers still stopped, run
`python -m nexus.services.chat.convert_reference_quotes` in the deployed api image's
separate 512-mib compose `migration` one-off. use the captured deployed config,
explicit database-only `NEXUS_CODEX_CONTROL_ENDPOINT` and maintenance role described
in [application maintenance](../../deployment.md#application-maintenance).
never import application services in a serving api or worker container.

conversion uses each row owner's current reading and annotation authority. it
freezes readable text ranges as plain quotes with bounded context, drops
unresolvable text locators, leaves pdf/time places alone and prints frozen/dropped
counts. inspect representative attachment/citation, private annotation and partial
reading rows. a second run must report zero changes. only then restart writers.
old rows have no saved words until this run; it cannot recover already lost text.

source republication remains blocked while saved text parts pin it. quote
qualification uses admitted part redefinition and republication of unpinned
sources; no source-generation or part-lifetime rule changes.

after verified production conversion, remove
`python/nexus/services/chat/convert_reference_quotes.py` in the next change. qualify a real
selection, published citation, source republication, unavailable source, reader
connections and turn deletion in the paired installed clients.

resolved when paired deployment, conversion counts/idempotence, installed-client
qualification and command removal are recorded in their implementation pr.
