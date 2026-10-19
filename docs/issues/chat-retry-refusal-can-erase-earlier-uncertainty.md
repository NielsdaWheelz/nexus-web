# a refused retry does not settle an earlier delayed admission

status: open
origin: 2026-10-16 chat viewer adversarial specification review
area: chat / admission feedback

`python/nexus/services/chat/admit.py:203-237,240-274` resolves catalog evidence
before acquiring the per-key transaction lock and stores no rejected decision.
an original attempt can retain an eligible row while delayed before admission;
a retry can receive a catalog refusal first without fencing the original.
`apps/web/src/components/chat/conversationStore.ts:327-330` then discards the
repeat key for a non-ambiguous refusal. `lib/chat/drafts.ts:128-136` likewise
clears pending on definite feedback. sources at `69c00182c`; the same admission
semantics remain at reviewed main `ff5712884`. no live reproduction performed.

impact: the ui can report settled failure and permit fresh intent while the
original request can still admit later.

fix: preserve whether any earlier delivery is unresolved. a later refusal or
authentication handoff cannot clear it without accepted entity evidence or a
proven revision/absence fence. the viewer's existing-chat owner must follow
that rule; creation/recovery policy remains separate. no replay ledger.

acceptance: delay the original after catalog resolution, refuse its retry,
then release the original. the ui never clears the unresolved command or
creates a fresh run automatically; subsequent evidence settles the same intent.
