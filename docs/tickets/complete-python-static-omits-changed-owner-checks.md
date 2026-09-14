# complete python static can omit changed owners

status: open
origin: 2026-09-14, pr #246 ci run `34810541373`, receipt `1981c1374f4f09dc`
area: test controller, python type-check selection

`python/nexus_test_control/runner.py:1712-1747` runs bare pyright for
complete scope or a changed pyproject/lock; focused scope instead supplies the
selected files explicitly at lines 1752-1783. the complete path drops those
selected owners when they lie outside `python/pyproject.toml:94-194`'s curated
include list.

the ci receipt at sha `0621251a6f0774ae5b9b63c7a3664c97d958c755` records
18 pyright errors: one in `services/pdf_ingest.py`, sixteen in
`services/podcasts/episodes.py`, and one in `services/search/candidates.py`.
all three are selected explicitly by the recorded changed command and absent
from the curated include. evidence is retained in that receipt's
`static-python-3.log`; artifact upload did not lose the log.

prerequisites: none. make complete static retain the changed-owner type-check
surface alongside its curated baseline. preserve explicit scope and ordinary
diagnostics; do not silently expand the entire legacy typing surface.

acceptance: an error in a selected file outside the curated include fails both
changed and complete static, including promotion caused by pyproject/lock edits.
the broad baseline and external python owner checks still run.
