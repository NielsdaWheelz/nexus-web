# quick reads: lectern verification

status: implemented, verified and cleaned · 2026-10-14
contract: [specification](quick-reads-lectern-plan.md).

baseline: `b6768bee2469cbc3a43902302836a44d07a11ea7`.
implementation: `e1af653b2944ca314dace0ee8eeb7ed8cb3f9753`, isolated branch
`codex/quick-reads-lectern-20261014`; the original
dirty checkout was preserved. only the approved spec and scoped issue records
were imported. [sanitized receipts](verification/quick-reads-lectern/receipts.json)
include imported-spec identity, fixture ids, network bodies, sql observations,
streaming timings and per-case results.

## observed proof

temporary tests drove real browser → bff → api → disposable database. articles
used ordinary capture/upload/publication and the normal background worker.
capacity, hidden membership and teardown used explicitly labelled database
preconditions, restored after each case. faults lost or delayed actual responses;
they never invented a successful receipt or replaced the mutation owner.

| requirement | observation |
|---|---|
| independent red | baseline lacked the button, moved an existing member on stale add, and did not reread a kept pane on activation |
| add and composition | quick reads, suggestions, menu and transcript send singular ensure; title-open sends no command; quick-read rows/order remain |
| canonical semantics | same/fresh ids preserve membership id/time/order; replay after removal/access loss acknowledges without recreation; changed-body replay refuses; deliberate first placement still moves |
| admission/order | 2,000 canonical / 1,999 visible rows report full; fresh add refuses, present ensure succeeds, unresolved check remains available; retained suggestions guard fresh keyboard activation; append follows hidden tail |
| uncertainty | committed but lost receipts remain unconfirmed despite present reads; explicit check repeats exact id/body; delayed first delivery follows server order |
| finite attempt | stalls before headers and after the first real byte release at about 30 seconds; another ui edit works; retry preserves serialized bytes |
| facts and lifetime | old action reads cannot regain freshness after receipt; failed reconciliation offers fact retry; recovery survives navigation/removal/dismissal |
| focus/content/layout | completion returns current button focus to title/play; moved focus stays moved; full labels fit at 320/360/390/414px with 200% text |
| reactivation | kept pane rereads on activation; first-load error and retained refresh error show distinct truthful retry copy |
| shared transport | supplementary red lost a real 404 body and reached the defect boundary; green recovers and retries identical bytes after the shared fetch repair |
| final built app | standalone artifact at the implementation commit passes ordinary open/add/remove; account teardown clears recovery and the mounted second owner receives no old notice/request/membership |

the first narrow-layout green attempt failed and drove the scoped reflow change.
its transcript case was initially unprovisioned; the later ordinary podcast
discovery/acquisition fixture supplied a playable descriptor and proved transcript
add/focus. the provider fixture served synthetic external metadata through the
existing configurable upstream interface. audio playback, transcription and
model enrichment were outside this qualification.

screenshots: [ordinary add](verification/quick-reads-lectern/ordinary-added.png),
[320px / 200% text](verification/quick-reads-lectern/narrow-320.png),
[complete capacity](verification/quick-reads-lectern/full-capacity.png).

## limits and tradeoffs

full labels spend vertical space on narrow panes. enlarged text still exposes
[shared metadata clipping](tickets/collection-metadata-clips-with-enlarged-text.md);
the add label fits. suggestions’ approved focus/refill follow-ups remain open.
the successful build also emits an inherited [add-panel css warning](tickets/add-panel-css-build-warning.md).
local chrome proof establishes neither production nor handset/screen-reader
behavior. reload loses unresolved client recovery; server transaction order
allows a delayed first request after removal. deleting tests relinquishes future
automatic regression detection, as requested.
normal sign-out closes the old document/request before attempted late delivery;
the account check does not fabricate a same-document owner replacement.

## final gate and cleanup

static checks, production build, ordinary built-app add/open/remove and owner
sign-out pass. all labelled database preconditions were restored. owned api/web,
fixture provider, worker, auth/database/storage containers, volumes and networks
were removed, along with the detached baseline, tests, playwright installation,
private credentials/profiles/logs and disposable-environment build artifacts.
the owned campaign directory no longer exists; other projects were untouched.

the [post-cleanup static gate](verification/quick-reads-lectern/static-checks.txt)
passes, including generated wire freshness, eslint/typescript, python checks and
one migration head (`0277`). four feature tickets are resolved; the two approved
suggestions follow-ups and two scoped layout/build findings remain open.
`./scripts/test` remains the sole permanent automated gate and is unchanged.
