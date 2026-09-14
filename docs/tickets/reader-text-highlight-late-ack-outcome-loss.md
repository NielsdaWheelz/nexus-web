# text highlight presentation retirement discards committed acknowledgment

- status: open
- origin: 2026-09-14 bounded reader residency review
- area: hosted text highlight creation

`MediaPaneBody.tsx:3464` receives a successful `createHighlight` result, then returns null if `projectTextHighlightMutation` rejects the obsolete presentation. `useHostedTextHighlights.ts:243` rejects a retired mutation session. the committed write acknowledgment is thus lost to callers such as the quick-note creation owner when its source presentation retires. the pdf owner preserves the write result independently of paint adoption.

prerequisite: reproduce through the real text creation/quick-note boundary with a held acknowledgment and retired source. return the authoritative write result while skipping obsolete presentation effects; do not introduce another row cache or cancel committed work.

acceptance: source retirement cannot turn a committed highlight into a null creation outcome, resurrect old paint, or affect a replacement reader. preserve exact server id and mutation result with a held-response sensitivity proof.

actual duplicate red: `8dc117abaab54f16` starts Ask from a text selection, selects another painted highlight while the create response is held, then receives `409 E_HIGHLIGHT_CONFLICT` with the existing id. the original chat action disappears because optional detail belongs to the superseded session. the normal200 case passes after the presentation-only fix. the body now returns its existing id-only action acknowledgment; the detail owner's superseded-session-null contract remains unchanged. exhausted detail failure and final sensitivity still need review.

ordinary coupled green `f1cefb10b390759f` and `6a74c25d6cbc46ac` preserve exact200/409 action ids after optional detail retirement. the latter also exhausts actual current detail reads with502: the existing reader defect and reachable Retry remain visible while the acknowledged Ask destination survives. the mutation detail owner remains unchanged. final canonical sensitivity is pending.
