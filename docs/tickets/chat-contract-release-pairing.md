# chat wire cutover requires one release vector

status: open; production pairing unverified · origin: 2026-09-28 pr #412 merge (`27e961be6`) · area: chat release

pr #412 changed the saved chat-run response and its exact web decoder. the old
backend sends `cancel_requested_at` and a different `run_selection` shape
(`fbd08ba68:python/nexus/schemas/conversation.py:887-899`); the new web expects
the keys in `apps/web/src/lib/conversations/messageWire.ts:81-97` and rejects
extras at line 201. the new revision header cannot protect a new web client
talking to an old backend that does not check that header.

this is a release-order hazard, not an observed outage on the product domain.
on 2026-09-28, public frontend and api `/version` both returned deployed
`7dc68929b4d5ddfd77eb1a50228d477fa0148b5d`; the api reported database
`0241`. the pr #412 vercel build was ready as a production-target candidate,
but `nexus.nielseriknandal.com` still served the old sha. the runbook
(`deployment.md:77-79,124-129`) requires backend migration and health before
promoting the matching web deployment.

prerequisites: resolve the `0246` uncertain-work blockers, run the `0250`
production preflight, and verify the release backup. release one exact current
main sha through `deploy/hetzner/deploy.sh`; do not promote a staged web build
against the old backend or add a dual-shape decoder for this hard cutover.

2026-10-03 activation qualification: reviewed production SQL still reports
`0241` with 24 camel activation paths in stored mutation receipts. the selected
canonical-snake cut adds `0253` bounded receipt-key/oracle nullable-key
migration and paired HTTP/SSE/web contracts. staged preview and exact-head CI
prove the candidate, not matching live API/web publication. migrate and establish
backend health before promoting that same web sha; no deployment was requested.
source ownership: `deploy.sh:109-116` verifies staged version, invokes the backend
controller, then promotes; custom-domain auto-assignment must remain disabled
(`deployment.md:77-79`). no new live config/settings inspection was performed.

2026-10-04 tool-vocabulary qualification: the locked declaration owner omits
`CredentialRejected`; the pre-regeneration browser projection accepted it.
local stream preparation returned 409 before replay. regenerating the browser
projection restores current revision pairing and removes that tag. no production
or historical stored-error census qualifies older `CredentialRejected` rows.
inspect those rows and resolve their release policy before claiming saved-chat
acceptance; current-vocabulary fixtures do not establish it. source evidence:
`/tmp/nexus-cleanup-20261004-chat-sse-projection-owner-evidence.json`
(`a93541ae05f5941006f8b9536826f8fdda19b48cddf7c836ad65a7416af08923`).
the failed 409 response envelope was not retained; no production request ran.

acceptance: the release controller proves the same sha on the backend and
custom-domain web, at the baked database head; authenticated new and saved chat
reads, send, same-run stream recovery and stop succeed after promotion. if an
early promotion occurs, restore the previous compatible web alias until the
backend can be released.

2026-10-04 chat rewrite: the chat contract revision is now "2" and migration
`0261_chat_tree_owner` drops `conversation_branches`,
`conversation_active_paths`, `messages.message_document` and
`messages.branch_root_message_id`. an old api's message inserts fail against the
migrated schema and the old web reads `GET /conversations/{id}/tree` in the old
shape, so the same one-vector rule applies: stop the writers, migrate and prove
backend health, then promote the same web sha.
open tabs at deploy get `409 E_CHAT_CONTRACT_RELOAD_REQUIRED` and the reload
notice; their `nx_chat_draft.v5` drafts are not read.

2026-10-10 generation rewrite: the chat contract revision is now "3". the send
and repeat bodies drop `catalog_definition_revision`, `GenerationCatalog` drops
`definition_revision` and `ChatSeed.policy_revision`, `RunSelectionOut` drops
both catalog revisions, and migration `0269_drop_generation_replay` drops the
replay tables and columns the old worker writes. the same one-vector rule
applies.
