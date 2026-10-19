# page menus on a phone ignore Back

status: deferred (product call) · origin: 2026-10-10 overlay kernel reauthor (cleanup/overlay-kernel-reauthor) · area: web / overlays

the overlay stack keeps a history entry only while a modal is open
(`apps/web/src/lib/ui/overlay.ts`, `syncHistory`). with no modal, a page-level
menu, floating surface or citation card does not own Back: android Back leaves
the page and the menu goes with it. modals (dialogs, sheets, the Nexus task)
and every transient inside them do own Back.

impact: a reader who opens the reader's More menu on a phone and presses Back
to close it lands on the previous page.

decision needed: whether page transients on phones should own Back. the cost
is one history push and one traversal per menu opened on a phone; the benefit
is that Back always closes what is open.

resolved when: the product call is recorded here and, if transients should own
Back, an overlay harness journey pins Back closing a page menu on a phone
without leaving the page.
