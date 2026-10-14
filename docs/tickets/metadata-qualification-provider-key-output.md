# provider key exposure during metadata qualification

status: open; rotation explicitly deferred by owner on 2026-10-14
origin: 2026-10-13 metadata qualification; release review 2026-10-14
area: local and production provider credentials

owner disposition, recorded `2026-10-14T03:51:37Z`:
“defer rotation; keep it recorded as open”. no rotation prompt or key/account/env
change follows this decision. the exposure and affected production bindings
remain confirmed; this disposition does not mark them resolved.

the originally reported exposure is independently confirmed. reviewer call
`call_67b101599d074956b2bd2014a36ec4e0` ran
`cat /tmp/nexus-metadata-20261013-impl/worker.override.yml` at
`2026-10-13T22:04:12.513Z`; its result at `22:04:12.586Z` contains both raw keys.
the source-read call `call_8269b0b9a3814c48a7f69d0d63a4e1b9` at `21:57:19.283Z`
identifies `/Users/nnandal/Documents/code/nexus-web/.env` as the input.
values were compared only in process and were not copied or printed again.

the exposed values exactly match the current mac bindings and retained live
production inputs. production `OPENAI_API_KEY` and `OPENAI_GENERATION_API_KEY`
share that exposed openai key; `BRAVE_SEARCH_API_KEY` matches the exposed brave
token. the prepared r7 cleanup inputs also retain them. dev-server's main `.env`
uses different values. the production process was not re-read during deployment;
other projects were not scanned.

impact: replacement affects embeddings/indexing/document search, the openai api
generation route, and brave web search in the api and workers. native codex login
has a separate credential owner. no claim of misuse or exposure of other keys.

content-free evidence: release artifact directory `provider-key-exposure-review/`,
`confirmed-exposure.json` sha256
`ea8015d43d47087130ca9c10fb4e9be16d9fb310bb5597582c1b6c27228ca191`.
the receipt locates the original retained session and exact call/output lines;
it contains no key values or key fingerprints.

no provider-admin connector or admin key exists in the scoped known inputs.
[openai administration](https://developers.openai.com/api/reference/administration/overview)
requires separate admin authority; ordinary model credentials do not establish it.
[brave key rotation](https://api-dashboard.search.brave.com/documentation/guides/authentication)
uses the authenticated api dashboard. no authenticated management session was
established; no account, env or service change was attempted.

if the owner later resumes rotation: use the affected openai project/key-owner and
brave account dashboards, or provide the coordinator an authenticated management
session. replacement values go directly into a private `0600` local file, never
chat. populate all three affected bindings; respect the existing embedding and
generation owners. the coordinator must drain work,
publish and activate reviewed config, verify the three normal capabilities, and
revoke the exact old keys. immediate revocation trades temporary capability loss
for a shorter exposure window; choose the cutover order explicitly. rebase r7
inputs afterward so cleanup cannot restore the exposed values.

no rotation has occurred. the currently prepared r7 inputs remain potentially
usable if their hashes match fresh live inputs at the later authorized gate;
do not rebuild or publish them now solely because rotation was deferred.

acceptance: old keys revoked; affected running consumers use replacements;
embedding, openai generation and brave checks pass; unrelated config preserved;
r7 rebased; retained-output access assessed. receipt deletion alone is not
revocation. never include key values in tickets, receipts, commits or messages.
