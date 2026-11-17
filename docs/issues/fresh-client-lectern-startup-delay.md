# first owned-profile startup delays useful lectern content

on `e6ee83f67`, a fresh authenticated chromium verification profile took 11.724 s
from navigation start to current lectern rows. its lectern request took 851 ms
at the browser edge / 702 ms in the api; most elapsed time preceded that read.
the workspace GET completed at 01:39:21.760 utc, before the lectern completed
at 01:39:31.035 utc. this is not yet attributed to scripts, auth, local storage,
workspace adoption or initial authored catch-up.

impact: a fresh device can feel slow despite the repaired summary statement.
the same-profile reopen on `4ea24bcaf` showed current main rows in 3.009 s
and warm rows in 64 ms. supporting quick reads still took 8.294 s and two book
images hit pool refusals. that remaining owner contention is tracked in the
read release issue; it does not attribute the earlier fresh-profile delay.
the temporary harness failed only at its final warm account selector after
recording those clocks. its browser/helper processes are confirmed stopped.
do not claim a retained-client regression from this fresh-profile result.

resolve by measuring the startup dependencies at their actual boundaries and
qualifying ordinary retained navigation. no cache purge, personal-profile
inspection, fabricated timing threshold or storage/freshness-policy change.
private evidence: `~/.local/state/nexus-read-responsiveness-20261116/ordinary-production-observation.json`.
