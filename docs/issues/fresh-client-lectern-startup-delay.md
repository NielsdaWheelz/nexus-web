# first-client startup still needs attribution

on `e6ee83f67`, a fresh authenticated verification profile took 11.724 s to
current lectern rows; the lectern request took 851 ms at the browser edge and
702 ms in the api. most elapsed time preceded that read. its cause remains
unattributed; this is separate from the repaired shared-summary statement.

on `6d130e45c`, the retained profile showed main content in 2.855 s, quick reads
in 6.072 s, reader content in 3.022 s, settings in 2.279 s and warm main content
in 63 ms. lectern and quick-read browser requests took 1.523/3.217 s. all 86
completed account requests were successful; no pool refusals. the interval
also contained 24 successful health checks.
four response-less read attempts were followed by successful responses on the
same routes; their cancellation cause was not captured. a new-device load on
this final source was not observed. soft latency guidance remains missed.

resolve by measuring the actual startup dependency chain and qualifying useful
current content on a fresh owned device. do not purge personal caches, infer
cold-database timing from a new browser, or weaken freshness. private receipts:
`~/.local/state/nexus-read-responsiveness-20261116/ordinary-production-observation.json`
and `ordinary-production-after-scope-observation.json`.
