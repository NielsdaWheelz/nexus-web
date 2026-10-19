# delayed generation opening can outlive its job

`services/generation/run.py:100` opens the ledger row after detached catalog
resolution. `services/generation/ledger.py:37` serializes that insertion by owner,
but does not recheck the job claim. a worker delayed past conversation deletion
can therefore insert an operational `llm_calls` row after its run and job are gone.

observed on isolated postgres while qualifying x read completion: deletion owns
the generation advisory lock, revokes the job and commits; the delayed real
`open_generation` then succeeds. the actual `Call.fence` refuses and no tool
receipt or retrieval effect commits. deletion and completion remain safe; the
ledger can nevertheless describe work whose authority already ended.

resolve at generation admission: check the existing job/owner authority before
opening or dispatching a generation, under the existing ordering protocol. qualify
revocation during catalog resolution and while waiting for the owner lock; no
new generation or provider dispatch should follow lost authority. this broader
generation-start change is outside the x source/reader cutover.
