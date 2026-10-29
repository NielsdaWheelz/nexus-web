# extension popup operational feedback

the browser extension popup still inserts capture request status and recoverable
errors into its content. its independent popup entry is outside the quiet-feedback
spec's web workspace, shelf and android capture host cutover.

evidence: `apps/web/src/extension/popup.tsx:328` renders capture failure actions
with `FeedbackNotice`; line 367 renders request phases with `FeedbackStatus`.
these can move the popup's existing controls as a request changes state.

resolve by adapting the popup's existing capture owner to a real bounded feedback
host and stable control slots, preserving uncertain submission/check/review
semantics. prove it in the packaged extension, including retained capture input,
keyboard focus and recovery after a failed or unconfirmed submission.
