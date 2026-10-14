# pane loading status remains busy until removal

status: verification pending
origin: 2026-10-14 session-entry accessibility review
area: web / loading feedback

`apps/web/src/components/workspace/PaneLoadingState.tsx:13–24` puts its polite
live status and `aria-busy="true"` on the same node, then removes the node when
loading ends. assistive technology may defer the announcement until busy clears.
this is a source-derived hazard, not a reproduced screen-reader failure.
[aria busy contract](https://www.w3.org/TR/wai-aria-1.2/#aria-busy).

prerequisites: none. remove busy from this disposable placeholder; retain its
accessible name, decorative bars and explicit `None | Polite` caller contract.
the persistent pane header already owns the pane's busy semantics.

acceptance: inspect the accessibility tree and manually check a slow active pane
with a screen reader; one useful announcement is available while loading, and
the placeholder disappears when content arrives.

source repair and live semantic proof passed on 2026-10-14 at `e9741da69`: no
disposable busy attribute, one active polite status and no inactive announcement.
actual spoken screen-reader output remains unverified; keep this ticket until the
slow-active-pane check above passes.
