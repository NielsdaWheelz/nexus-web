# first owned-profile startup delays useful lectern content

on `e6ee83f67`, a fresh authenticated chromium verification profile took 11.724 s
from navigation start to current lectern rows. its lectern request took 851 ms
at the browser edge / 702 ms in the api; most elapsed time preceded that read.
the workspace GET completed at 01:39:21.760 utc, before the lectern completed
at 01:39:31.035 utc. this is not yet attributed to scripts, auth, local storage,
workspace adoption or initial authored catch-up.

impact: a fresh device can feel slow despite the repaired summary statement.
the same-profile retained reopen is not yet observed because the temporary
playwright teardown stalled; the browser is stopped and its profile retained.
do not claim a retained-client regression from this fresh-profile result.

resolve by measuring the startup dependencies at their actual boundaries and
qualifying ordinary retained navigation. no cache purge, personal-profile
inspection, fabricated timing threshold or storage/freshness-policy change.
private evidence: `~/.local/state/nexus-read-responsiveness-20261116/ordinary-production-observation.json`.
