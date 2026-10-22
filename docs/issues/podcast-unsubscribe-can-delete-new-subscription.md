# delayed unsubscribe can delete a newer subscription

`python/nexus/services/podcasts/subscriptions.py:200-231` deletes by viewer and
podcast, without the subscription id the initiating view observed. another tab
can unsubscribe and resubscribe before an older delete arrives; that old command
then removes the new subscription, its settings, and qualifying placements.
the resource-action busy lock is local to one mounted provider and cannot fence
another session. baseline: `380400362c03`.

reproduce with two authenticated sessions: hold a delete from the first, delete
and resubscribe in the second, then release the first delete. the second
subscription is removed. this follows directly from the service predicate;
the race has not been exercised live in this change.

resolve at the subscription command boundary with explicit observed-generation
semantics, including the already-absent retry rule. prove a delayed old delete
cannot remove a new subscription while ordinary delete retries still converge.
the pane-controls change preserves the existing command contract; this needs a
separate domain decision and qualification.
