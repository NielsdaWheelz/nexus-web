# mobile tap dispatch is unverified on real ios webkit

status: open · origin: 2026-10-10 app navigation reauthor (cleanup/appnav-reauthor) · area: web / mobile chrome

problem: real ios dispatch remains unqualified. the owner confirmed no ios
device is available for the persistent-player qualification (2026-10-21).
`lib/mobileShell/readerTap.ts:21-48,63-76` matches a trusted completed pointer
sequence to its native click by pointer id. `GlobalPlayerSurfaces.tsx` now joins
that shared chrome contract for idle, loaded and unavailable contents.

`components/switchboard/NexusButton.tsx` also now suppresses compatibility
mouse focus during admitted touch presses so restoring the player cannot move
nexus between release and click. browser and physical android qualification do
not establish ios dispatch for that changed path.

desktop playwright webkit2370 cannot substitute for ios touch proof: with
`hasTouch: true`, `isMobile: true`, a viewport meta tag and a paragraph inside an
ancestor with a click listener, `locator.tap()` emits trusted down/up with
`pointerId=0, pointerType=touch`, then a trusted click with
`pointerId=1, pointerType=mouse`. the reader correctly rejects that mismatched
sequence. `locator.click()` emits id1 throughout and can qualify browser
geometry/mouse activation only. earlier desktop-webkit passes do not establish
the current ios path. do not weaken gesture ownership for this emulation.

what to do: on an iphone (safari, or the hosted app in a wkwebview), retreat the
chrome in a long article and tap blank paragraph text; then tap mid-retreat.
repeat with idle and playing footer contents; confirm inertness, preserved
reading position and the stationary player slot. scrolling must preserve the
current visibility target.

also tap nexus from a focused root input after dismissing the keyboard: one
completed tap must open the task and transfer focus. a stationary tap must work;
a press moved at least 8 css px must not open it after returning inside. check
both adjacent-tab swipe directions and usable task input focus. canceled
touches preserve the original input focus; committed swipes use destination
focus. keep system navigation areas clear.

resolved when: those reader/nexus taps, swipes and geometry/focus invariants are
observed on real ios, or an observed defect is repaired and the journey repeated
there. status remains `NOT_RUN` for the device boundary.
