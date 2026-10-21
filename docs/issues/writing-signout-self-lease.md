# sign-out mistakes its own unfinished shared lease for another tab

lab 6 confirms first sign-out reports `other_tabs` with only one page. `journal.ts`'s lock release resolves the held callback's inner promise but does not wait for `navigator.locks.request` to finish releasing the native lock. `prepareSignOut` immediately requests the same runtime lock exclusively with `ifAvailable`, which can still see this tab's shared lease.

return the actual native request completion promise from the release function. await it before a same-name handoff, including shared-to-exclusive sign-out and exclusive-to-shared cancellation/restoration. no timer, polling or protocol bypass is needed.

resolved when first sign-out in a single page reaches its real review state, a real second page still refuses exclusivity, and cancelling or failing sign-out restores usable editing.

source repair: the lock primitive returns a typed release receipt backed by the actual native request completion. both sign-out runtime handoffs await it and recheck the account capability before reacquiring. release callers now await completion; branch release removes its old map entry before waiting so a newly granted claimant cannot be erased. live qualification remains pending.
