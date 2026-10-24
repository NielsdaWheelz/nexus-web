# collection actions

resource actions operate on the whole accessible podcast or library. explicitly
labelled podcast view actions may select a state. selections are finite: new
arrivals and subsequent source ordering do not change reviewed ids.

`schemas/collection_actions.py` owns the closed transport models.
`consumption/collections.py` composes canonical ordered selectors and consumption
state; `consumption/lectern.py` owns lectern changes. a library selects physically
contained media, never episodes implied by its subscriptions. all selects its
canonical distinct physical union. catalog inspection does not grant playback.

## state and exact inverse

`POST /consumption/collections/prepare` captures ids and nullable override revisions
in repeatable read. `PUT /consumption/collections` takes that frozen selection and
absolute `finished` or `unread`. a serializable viewer transaction validates current
readability, unfiltered source membership and every differing revision before any
write. an already-desired override is inert. source loss, access loss or one stale
revision refuses the whole batch. positions, observed history and lectern stay.

the acknowledged answer contains an inverse for changed entries only: prior
explicit status, applied revision and any newly created completion id. null prior
status means no explicit override. an inert repeat returns no original inverse;
there is no retained server receipt or causal attribution from current values.

`PUT /consumption/collections/undo` requires current media access, not the original
collection. every entry must still be at its applied revision/status, or every
entry must already be restored at applied revision plus one with its created
completion absent. mixed or superseded states refuse atomically. first undo
validates and deletes completion facts only by `(id, user_id, media_id)`, restores
prior statuses and advances revisions/fences. pre-existing completions and later
progress stay. exact already-restored replay is inert and proves a postcondition,
not which request caused it. revision rows and old epochs are never restored.

the existing account consumption owner retains exact request bytes and received
inverse receipts across pane navigation, without a timer. account teardown/reload
ends them. `withProgressFence` flushes and pauses all matching holders before
apply/undo; failed preparation sends nothing. successful prepared pairs reconcile
afterward. conflicts require another review; no recapture or rebase is implicit.
known overlapping state effects retire entire older inverse offers. received
revisions order those effects: late older acknowledgements cannot replace a newer
inverse; inert choices and equal-version postconditions preserve valid offers. an unused
offer is not unsaved work; sending/unknown effects retain the account loss guard.
a refusal after uncertainty cannot settle the earlier attempt. read refreshes
never acknowledge writes. acknowledged effects publish consumption and podcasts;
actual state/inverse effects record one durable suggestion input change.

installed-app writes require current remote admission, checked again after progress
preparation and before transport. loss of admission before sending creates no new
uncertainty and preserves a valid inverse. an earlier uncertain attempt still owns
its exact retry and guard. reads becoming available never resume writes.

protocol defects stop workspace presentation beneath the account owners. their
exact pending requests, feedback and loss guards remain available for recovery.
lectern read defects follow the same containment boundary; a failed read cannot
settle an uncertain write.

## lectern

`POST /lectern/collections/prepare` freezes unfinished ids, including in-progress,
the order revision, existing count and available capacity. episodes use oldest
publication order; named/system libraries use stored order; all uses newest-added
order. existing lectern entries retain positions. missing entries append in the
captured order. there is no future auto-add or bulk lectern inverse.

`PUT /lectern/collections` compares the reviewed revision before membership
equality, then validates all ids' access/source membership, missing targets'
unfinished state and total capacity. hidden rows count toward the 2000-row cap.
any failure refuses the entire insertion. canonical id lock order is independent
of insertion order. `append_missing_in_txn` advances the sequence revision once,
including accepted nonempty no-ops; revisions need not be consecutive.

the existing account lectern lane admits a reviewed batch only while idle at its
exact revision. single writes and moves cannot overtake it. unknown delivery
retains bytes/revision and blocks the lane. a newer read may supersede the intent;
it cannot establish acknowledgement. no second lane or automatic rebase exists.
accepted membership intent records one durable suggestion input change, including
a nonempty no-op; acknowledgement publishes lectern. the originating review closes
synchronously through its identity-gated acknowledgement callback before the
account owner settles its feedback condition with the exact added count. unrelated
work or another modal retains the shared feedback policy's normal suppression.
