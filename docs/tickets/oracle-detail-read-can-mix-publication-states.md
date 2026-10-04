# oracle detail read can mix publication states

status: open, source-qualified; live reproduction not run · origin: 2026-10-04 simplification audit at `2a0b31369132fefbd913f317dffe659ebc8cb98d` · area: oracle reading hydration

`python/nexus/api/routes/oracle.py:68-74` supplies ordinary `DbSession`. `db/engine.py:41-49` does not override postgres isolation; the owned isolated database reports `read committed`. `services/oracle.py:302,337-345,1301-1305` reads the parent, then its events in separate statements without refreshing the parent. terminal publication is atomic (`oracle.py:786-971`), but it can commit between those statements. the session can retain a pending parent and read its new terminal `done`; `schemas/oracle.py:361-362` then rejects it with `non-terminal Oracle reading carries a terminal event`.

use the existing `RepeatableReadDbSession` / `get_repeatable_read_db` owner in `python/nexus/db/session.py:56-66` for the composite detail read; it requires a fresh session before any query. a future snapshot projection still needs one coherent observation of parent, folios, citations and historical metadata. no writer, provider or generation-journal change is needed.

acceptance: in an isolated reading, hold detail after its pending parent read, commit an actual native terminal publication, then resume. the response observes one valid pre- or post-publication state; a later read observes the terminal state. prerequisite: a legitimate owned reading and native publication fixture. current evidence establishes the permitted interleaving, not an observed browser or production failure.
