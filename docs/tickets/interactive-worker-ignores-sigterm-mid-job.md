# the interactive worker ignores SIGTERM inside a running job

status: open (pre-existing; not changed by the jobs reauthor) · origin: 2026-10-10
jobs runtime reauthor, design R6 / coordinator R6 · area: jobs runtime / release

the interactive lane runs its handler in the worker's own process
(`jobs/process_executor.run_in_process`). SIGTERM only sets the worker's `stop`
event (`apps/worker/main.py`), which the loop reads between jobs; no in-process
handler observes it. a chat run, dossier build or metadata enrichment longer than
the release's `docker stop --timeout 30` (`deploy/hetzner/release.py`, the stop
before backup) is SIGKILLed: the container exits 137 and the release fails its
clean-stop check. the killed attempt is then reclaimed about 30 s after the new
worker starts.

proposed fix: let a running interactive job observe `stop` (the generation's stop
poll already watches its claim): end the attempt as `Released` (rescheduled,
refunded), so the lane exits 0 within the grace.

acceptance: a release during a running chat stops the interactive lane with exit
0, and the run resumes or ends `interrupted` after the release.
