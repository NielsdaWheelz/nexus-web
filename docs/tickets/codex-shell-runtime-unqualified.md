# codex shell runtime unqualified

status: open · origin: 2026-09-26 approved shell cutover · area: codex execution

## problem and evidence

the implementation is staged at nexus `d6b06991c` with the browser draft fix
at `a50401623`, llm-calling `6a7093f7`, llm-tools `d305da8f`, kernel
`937434b0`, and codex cli 0.157.1. on isolated database `nexus_shell_8e3`,
all 15 codex model/effort cells completed through browser, api, worker and
native host, with persisted usage and one terminal each. receipt:
`/tmp/nexus-shell-cutover/codex-15-d6b06991c-origin-fixed-receipt.jsonl`
(sha256 `40495277fbd49f5d50dccdaa90fe3bd6a61000797adbea5e14cd1253de0491d8`);
read-only ledger check sha256
`bb6e4d81641dc11e9ec284450d7b5a0a7c55e866bbeeaefdbf94532b6e766848`.

model-originated shell fetched the generated api schema, created and read a
note, then the browser undid it. separate runs read a note outside chat
context and proved exact-key replay with one durable write and changed-body
rejection. a model-originated `web.search` returned six brave results and used
the first title, url and eight normalized snippet words in its answer; the
initial verifier falsely failed on html markup in the raw snippet, while the
independent ledger/browser check passed (receipt sha256
`17bdd2f4376ac4ae3f330118ed9fd5ab5df0bf253963c39860d3a489b81046de`).
the x86_64 image `sha256:c8383decb18e874701cc822eca703eab8f24abe4d2a83130b1f1ccfe37ad5f5b`
passed its actual bubblewrap health probe as uid 10001 under production-style
container restrictions; no paid x86_64 turn was run.
the arm64 host's actual bubblewrap command passed public https, a small pypi
wheel download, scratch write/removal, credential/control/source path absence,
and direct database, metadata and ipv6-mapped database denials. receipt sha256
`f73992473d2e58648ad59d131045765006e3550cfe3ab0637fe38d17efa9c97a`.
it used no model turn. a separate synthetic child detached inside the same
namespace; normal `ExecServer.stop` left zero marked processes and removed
scratch (receipt sha256
`ecd1d07e0afee216498015c6159ec37a1d5f2bc4d9822606fe1e754074fab1ff`).
host-container death and restart remain unproved.

a note dossier completed strict json with a citation on `c792536af`, but did
not make its requested `nexus.note.create` call. a second build was quota
paused before dispatch and canceled. the twelve background roles and a
background effect/list/undo journey remain unqualified. receipt:
`/tmp/nexus-shell-cutover/background-dossier-receipt.jsonl`.
on final backend `d6b06991c`, build
`5a284dec-9f3c-4136-90ae-419f17713922` completed a cited revision, but
again recorded zero generation-api tool positions and zero account effects.
postgres confirmed the requested note marker was present in its persisted
user instruction and the generation had `CodexShell` authority. the model did
not call the shell; this does not prove an authorization denial. final-source
receipt sha256 `a58ef597917715083370856fb386df142e9f034d846abcd17e9c677ba2756d15`.
a follow-up that made the note uri a prerequisite never dispatched: job
`74e5e2e3-5ca6-4ffc-9cf4-9effe870b8ff` was quota-paused with zero
attempts/generations and then explicitly canceled. it cannot diagnose the
prompt. corrected receipt sha256
`5950251992cb11193e587e916111d133aa9980eeeb4b6193bb42bf66d04a57d8`.
the isolated database has one note, one page, two libraries and chat history,
but zero media, podcasts, contributors, highlights or idea subjects; those
roles need real subject fixtures before their live journeys can run.

## prerequisite and acceptance

determine why background synthesis ignored the explicit user instruction;
prove a model-originated background write before claiming the shared api grant
works for these jobs. prove the remaining shell-plan lifecycle and denial
cases, actual auth refresh on an independent disposable credential, all twelve
background roles with valid recorded output, and model-originated background
write/list/undo on the final runtime. retain temporary proof code until the
complete contract passes; do not infer background write authority from valid
strict json alone.
