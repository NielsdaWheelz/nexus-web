# article capture conflates extraction, transport and defects

status: open · origin: 2026-09-21 capture-routing review · area: browser extension

`apps/extension/popup.js:captureTab` catches every failure from `captureArticle`
except `CaptureApiError`, then attempts document/url capture. `captureArticle`
combines browser script execution, access to `capture.result`, and the backend
post. a missing script result therefore turns a `TypeError` into another capture
attempt; a failed response after an article post also selects another route.
this predates the permission fix and is source-confirmed, not a live data-loss
observation.

prerequisite: distinguish expected extraction failure from backend transport
failure and broken browser result contracts. keep legitimate unreadable-page
url capture and explicit backend rejection behavior.

fix: let extraction own its modeled failure; choose the capture route before
posting to nexus. propagate transport failure and defects through the existing
popup error boundary rather than silently selecting another operation.

acceptance: unreadable pages still use url capture; malformed script results
and an article-post transport failure do not issue a second capture request.
