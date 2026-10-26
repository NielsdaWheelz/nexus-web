# pending history exposes an obsolete placement as a second alias

external `f50e52f5a` inline-page history produces two distinct row ids for the
same page. scoped candidate `c19992566` still fails at undo-outdent in
`20261026-054735-129c8187d7d8`: one occurrence remains nested and another
appears at the root before the following text undo. prior text/order premises
pass. this is a presentation failure; canonical relation corruption or writing
loss has not been established.

`OutlineController.prepare` can overwrite an outstanding withdrawal, and its
logical source parent can already be root while `row.link` still describes the
old parent until its promise resolves. a committed-link id is not reliable
placement identity during that interval. retain exact occurrence/semantic-pair
ownership without a lookup fallback or a duplicate-stripping render pass.

source review also exposes mixed admitted revisions: after p1 -> root, the
target can adopt the child before the old source admits its withdrawal. a second
move can then leave two stale canonical windows for one saved previous parent.
the second move can retain `pending=false` while awaiting sql, so neither
`hasPendingWriting()` nor store/window revision equality excludes that schedule.

keep the earliest unproven admitted source through ordinary moves and history
replay. defer target adoption in the existing admission owner until compatible
source proof reaches the receipt revision; retain and explicitly reschedule its
proposal, without awaiting that same serial admission queue. superseded target
proposals must not adopt the intermediate placement while a newer move awaits
its receipt. require fresh source proof, not unconditional child absence: unseen
foreign additions may legitimately keep that pair alive. absent/empty source
windows and returning to the same source occurrence must not cause a wait.

resolve with immediate indent/outdent/undo and text history, retaining one
intended occurrence, exact canonical relations/text, repeated-appearance controls
and same native editing host. the same-parent-only source correction is not yet
a green qualification.

real held-writer run `20261026-070915-23d0f9169d20` also fails at the third
outdent after outdent/undo: two occurrences of the same child exist while sql
is still blocked. later cross-parent movement and typing are not reached.

unchanged withdrawn-target control `bd49ffce5`, root run
`20261026-075925-dd803fd38d62` on pre-placement `85cfeeff2`, also fails after
all canonical premises: an independent public unlink removes the parent from
root while own reparent/body writes are held; after release, `childx`, the new
parent-child relation, both resource identities and untouched control are
durable. real root focus succeeds, but the old parent row remains for ten
seconds. subsequent child-row/host assertions are not reached. this proves
stale visible projection, not hidden-pin or memory behavior.

whole-window source gating also has a cycle: move c from a to b and d from b to
a before either fresh window arrives. qualify an atomic smallest compatible
source-proof closure from existing proposals, with one revision and budget.
recheck all selected requests/leases/versions, current placement tokens and
already-admitted source provenance against the actual reachable set before
installation. only successfully installed targets retire placement metadata;
retain the same field's guarded relationship/body/baseline until projection
takes over. failed or superseded acquisition installs and retires nothing.
