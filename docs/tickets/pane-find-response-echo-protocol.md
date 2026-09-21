# pane find echoes caller-owned request identity

status: open
origin: 2026-09-21 cleanup reader audit at `93563d12b6`
area: web pane find contracts

`apps/web/src/lib/panes/usePaneFind.ts:25` requires preparation responses to
echo session/source identity; lines 44 and 76 repeat session/query/source/key
fields across query results and preview receipts. the controller already
captures these values before each promise, but validates the adapter's copies
at lines 352, 457, 507 and 645. every adapter copies the request verbatim:
web, epub, pdf, transcript, conversation and artifact. `returnAvailable: true`
also duplicates the `Previewed` discriminant and has no consumer.

impact: six adapters carry an unnecessary response protocol and helper code.
request identity is owned by the controller; these echoes establish no
additional identity or cancellation guarantee.

prerequisite: retain actual request-side session/query/source checks, aborts,
preview generations, source validation and format-owned rollback behavior.

proposed fix: return scopes from preparation and semantic data from query and
preview. construct the prepared session inside the controller. compare its
captured session/query values with current counters when promises settle;
remove echoed response identity and the redundant availability flag.

acceptance: `./scripts/test` passes. manually verify find/step/return, rapid
query replacement, close during preview, and source replacement. a completed
preview must still preserve return after close even when its signal was
aborted. preview movement must still leave url, progress and activity alone.
