# unused job payload batch reader

`python/nexus/jobs/queue.py:list_jobs_for_payload_values` has no callers.
`git grep list_jobs_for_payload_values 2705809b1` finds only its definition;
the dossier removal also leaves no caller. its metadata-specific docstring
therefore describes unused api surface.

impact: avoidable queue interface and sql maintenance. this predates the dossier
feature cut and is outside its deletion boundary.

resolved when the unused helper is removed, or a concrete caller justifies its
contract, and `./scripts/test` passes.
