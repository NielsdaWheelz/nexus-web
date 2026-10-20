# lab browser bootstrap navigation aborted

status: open; cause unconfirmed

one disposable run failed before its driver started: the password POST returned
303, then `apps/web/scripts/lab/auth.ts:59` failed with
`goto: net::ERR_ABORTED at http://127.0.0.1:61671/`. the owned web log recorded
`GET / 200`. four preceding toolbar labs passed this bootstrap. the failed run
tore down correctly; no toolbar assertion ran.

evidence: `.nexus-local/lab/20261020-003917-e01295db6f13/` contains
`browser-bootstrap.log` and `web.log`. do not infer an auth or toolbar defect
from the navigation error alone or add an unconditional retry.

resolved when: identify the competing navigation or server failure and qualify
fresh authenticated bootstrap repeatedly at its owner without masking errors.
