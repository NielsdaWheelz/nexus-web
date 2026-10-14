# local background worker requires linux

status: open
origin: 2026-10-13 pane-controls live qualification
area: local development / worker

`README.md` recommends `make worker-background` after local setup. on macos,
the ordinary worker exits in `python/nexus/jobs/process_executor.py:94` while
opening `/proc/self/cgroup` (`FileNotFoundError`). the background process owner
requires linux cgroups; the documented host command cannot ingest the live
reader fixtures on this platform.

prerequisite: use the existing linux container worker for ingestion. repair the
development instructions at their owner to state that requirement and provide
the normal container launch path; do not emulate cgroups in the worker.

acceptance: the documented macos setup ingests an ordinary uploaded document
through the real background worker without a platform exception.
