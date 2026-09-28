# chat reliability verification

status: implementation candidate; release blocked · 2026-09-27
implementation source: `1ef156931` on `feature/chat-reliability-main-plan`, based on remote `main` `fbd08ba68a699aa497c8281044a59f8709cf43ef`
current-main integration: `f70026920a83e8b2de56be5dc8fdfac440e4afef` applies the chat delta to remote `main` `4da38ace7653f7abb99e9b83324ab9bbb6bd8175`; generated wire was refreshed
production observed: source `7dc68929b4d5ddfd77eb1a50228d477fa0148b5d`, database `0241`

the implementation source contains the chat revision, catalog-independent
history reads, persisted run-owned stop state, safe dead-job settlement, host
first-cause logging, and a reviewed-identity gate for migration `0246`. the
old pane crash remains unattributed. no production image, migration, reset,
or deployment was made. the integrated source has no built image or observed
native codex revision; the older shell-cohort receipt is not qualification for
this commit.

the integration kept main's removed web-vitals route and dossier cutover while
retaining the distinct origin request id in client-defect telemetry. static
checks passed on the integrated tree with migration head `0250`. the behavioral
observations below belong to the earlier implementation source; they do not
qualify a final-tree paid or native reply.

## observed on this source

| boundary | result | evidence and limit |
| --- | --- | --- |
| static | passed on original and integrated trees | `./scripts/test` passed on the original candidate at head `0247` and on the current-main integration at head `0250`: ruff, pyright, web lint/type checks, offline and extension builds, generated wire, and one alembic head. |
| saved history during catalog outage | passed locally | fresh api on disposable postgresql `0247` started with no codex socket; authenticated run, list and tree reads and unrelated `/version` returned 200; `/llm-catalog` returned typed 503. authenticated next.js new and existing panes rendered without a page exception. catalog recovery after the host returns was not observed. |
| accepted command read | passed in disposable asgi proof | response hydration used frozen selection after a simulated catalog failure. a final-tree paid send and reply were not run. |
| stop and replay | passed locally; native drain not run | disposable postgresql proof covered eight valid-spec dead-job and duplicate-stop states. no-step, undispatched prepared and completed memo settled without renewing attempts; uncertain work stayed dead. a concurrent owner-lock proof rejected child arm before model call or bearer mint when stop committed first. uds cancel control returned 204; no real native process drain was observed. |
| run advisory and browser stop | passed locally; reply journey not run | authenticated direct sse showed queued stop intent within the existing 15-second idle-read bound without advancing the text cursor. disposable browser/reducer proofs covered stale advisory and read ordering, selected-run stop, paused status and reload; proofs were deleted. an authenticated existing pane rendered `Stop requested` during catalog outage. new and existing chats did not produce final-tree model replies. |
| wire | passed locally | authenticated stale chat read and direct sse returned typed 409 before work; unauthenticated read and stream returned 401 first. current revision read and sse succeeded. |
| diagnostics | passed locally; native chain not run | a host failure probe retained class, owned cause, stage, generation/child and native revision before normalization. an actual authenticated client-defect post logged distinct ingestion and origin request ids with run, command, phase and component, without prompt or bearer. the full native-host-to-caller defect chain was not observed. |
| migration identity gate | passed in disposable proof; production blocked | read-only snapshot and exact comparison passed on disposable postgresql. release-controller proof rejected missing, malformed and wrong-revision snapshots before shutdown and changed identities before backup/migration; an exact match proceeded. production backup, quiescence and disposition were not run. |

temporary red/green integration and live proof scripts were removed after the
observations above. the local browser saw the expected catalog 503 only; its
existing conversation remained readable. this does not reproduce or close the
original, nonreproducible production pane crash.

## release gates still open

- production has one nonterminal chat run with a dead three-attempt job, two
  chat generations with dispatched unterminated turns, and 41 dead media jobs
  with dispatched unterminated generations. missing tool-position rows do not
  prove absence of external effects. migration `0246` correctly rejects this
  state. an allowlisted, evidence-backed disposition and verified backup are
  required; see the [chat](tickets/model-history-cutover-blocked-by-uncertain-work.md)
  and [media](tickets/model-cutover-dead-media-generations.md) tickets.
- main now includes destructive dossier migration `0250`. its production
  stored-json guard, deletion counts, backup, and post-migration head check
  remain open; see the [preflight ticket](tickets/dossier-latest-revision-0250-production-preflight.md).
- the final commit needs authenticated new and existing chat replies, same-run
  stream-loss/reload and native process-drain observations on an actual pinned
  host. the original crash needs its initiating exception before anyone can
  claim it fixed. see the [browser](tickets/chat-composer-loses-durable-stop-state.md),
  [shell](tickets/codex-shell-runtime-unqualified.md), and
  [incident](tickets/production-chat-pane-crash-unattributed.md) tickets.
- inherited shell/latest-model qualification remains incomplete: twelve
  background roles and a model-originated background write, browser effect
  list/undo, auth refresh, death/restart and network denials, resource fit,
  and final-tree model cells. the 20 anthropic nexus cells need an owner
  retention/catalog decision; the four xai cells are waived, not passed.
  see the [shell verification](codex-shell-cutover-verification.md) and
  [latest-model ticket](tickets/latest-model-end-to-end-qualification-incomplete.md).

## explicit trade-offs

- stop records intent before the host's actual outcome. uncertain dispatched
  work can remain paused indefinitely; no request silently redispatches it.
- the existing 15-second sse idle read bounds advisory lag without a second
  notification path. the browser retains the last accepted stop across older
  same-run reads and advisories; terminal server state still wins.
- the new chat revision forces a coordinated reload. an acknowledged command
  is reread by its durable receipt; it is never automatically resubmitted.
- the reviewed cutover snapshot hashes full retained rows. a clean shutdown
  can change timestamps and require a fresh review. a matching database census
  cannot prove process drain, grant revocation, external effects or backup.
- the approved codex shell has public internet and the broad generation api.
  nexus records its domain-api effects, while shell and public-network effects
  have no equivalent nexus undo. the approved `0246` history reset is
  destructive, so an old image alone is not rollback after new writes.
- merging the code before live release qualification keeps the correction
  reviewable on main but does not make that tree deployable. production still
  needs the listed preflight and exact-source journey; `0250` also makes
  backup restoration part of backend rollback.
- deleting the temporary behavioral proofs leaves static checks as the only
  continuous repository gate. live qualification must be repeated for the
  exact release source.
