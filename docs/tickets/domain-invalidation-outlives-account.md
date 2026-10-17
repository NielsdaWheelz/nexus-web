# domain helpers can publish after account departure

status: open; source-qualified, no cross-account live reproduction
origin: 2026-10-16 feedback adversarial review
area: account lifetime / domain change publication

some older helpers publish global invalidation after awaiting their request,
without an account-owner guard: `lib/media/mediaLibraries.ts:10`,
`lib/chat/conversationIndex.ts:35`, `lib/notes/api.ts:27` and
`lib/libraries/api.ts:83`. a caller's post-await guard cannot suppress those
internal publications. this can provoke a new account's unrelated reread;
it is not evidence of cross-account data disclosure or a redirected navigation.

the feedback cutover fences its new owners and direct action continuations.
changing all domain helper contracts is outside its two-admission persistence scope.

fix at the account/change-publication owner when that contract is addressed.
acceptance: delay a real helper response, change account, then release it;
no change event reaches the new account, while the current account still refreshes.
