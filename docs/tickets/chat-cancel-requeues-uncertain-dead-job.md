# chat cancel can requeue uncertain dead work

status: open; native drain unverified
origin: 2026-09-27 current-main reliability audit, `fbd08ba68`
area: chat cancellation

`python/nexus/services/chat_runs.py:1041-1047` requeues any dead chat job on
every cancel request, including a repeated request after an uncertain codex
dispatch. `python/nexus/tasks/chat_run.py:54-99` can also wake cancelled dead
work after exhaustion. codex replay refuses uncertain dispatch in
`python/nexus/services/llm_execution.py:855-858`, so the current path can spend
attempts and transiently report work without settling it. this is a source
finding, not a production reproduction. main already suppresses one automatic
codex-uncertain dead-letter path; the older ticket's claim of an unconditional
automatic loop is stale.

preserve main's generation-api bearer closure and shell drain. under the
existing owner/job locks, wake once only when no step, an undispatched
prepared step, or an accepted completed memo proves local settlement. leave
uncertain work suspended for evidence-backed operator repair. prove repeated
cancel creates no new dispatch, tool effect, attempt budget or false terminal.

the 2026-09-27 candidate removed dead-job requeue. disposable postgresql
proof passed eight settlement/duplicate cases and an owner-lock stop/arm race;
uncertain work stayed dead with attempts unchanged. the uds host control path
returned 204. an actual native process interrupt and drain has not yet been
observed on the final tree; an acknowledgment alone is not a terminal fact.
