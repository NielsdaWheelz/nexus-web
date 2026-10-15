# libraries creation reserves a permanent row

status: implemented; final physical acceptance pending
origin: 2026-10-14 libraries-pane design review; checkout `367da80e0c1beb1c426f6d2d72201b0733809b50`
area: web / libraries interaction

implementation and browser evidence: [verification receipt](../libraries-creation-verification.md).
keep this cutover record until the remaining physical acceptance and final cleanup.
the findings below describe the pinned baseline.

implementation contract: [libraries creation plan](../libraries-creation-plan.md).
scope and recovery lifetime are settled; implementation is qualified in browsers.

the libraries index always renders its new-library form above the collection
(`apps/web/src/app/(authenticated)/libraries/LibrariesPaneBody.tsx:430-463`).
live firefox `/libraries` confirmed the separate input/create row. an occasional
command consumes space throughout browsing. success only clears the input
(:173-176); an active filter (:420-422) can hide the created library without a
success receipt.

prerequisite: implement the specified contextual creation contract: header action,
transient name form, return focus, pending dismissal, and success destination. the shared
header currently permits only more/inspector (`docs/modules/workspace.md:286-308`),
so an explicit primary-action slot needs an intentional contract update.

proposal: expose a quiet `+ new` before more, with a labelled compact dialog;
use an accessible plus at narrow widths. the pane owns draft, submitted id/name,
pending status and visibility outside the dialog content. reuse `Dialog` and
`createLibrary`, not the global nexus launcher, whose destination, dismissal and
return-focus contracts differ. success while the dialog owns the interaction
follows into the new library in the originating pane. close restores its trigger.
create-and-open also requires the existing filter to survive pane return;
[the filter retention gap](libraries-filter-is-not-retained-for-pane-return.md)
must be addressed before claiming that back recovers the full prior view.

pending close remains possible: it hides the form without cancelling or replacing
the write; reopening resumes that attempt. completion after close must not navigate
or move focus. `apiFetch` has no complete browser response deadline
(`apps/web/src/lib/api/client.ts:285-294,349-376`), so indefinitely blocking dismissal
would be unsound. acknowledge successful writes through the existing library change
publication even when the form is closed. uncertain failure freezes the same
id/name until resolved; reopening resumes that task. retain the attempt across
pane switching/back through visit memory; reload and permanent pane closure use
list inspection/live repair. say creation could not be confirmed when the server
outcome is unknown. no durable draft storage or background-job framework.

remove form-only styles and update empty-state copy at :490-491. the shared
primary-action contract also relates to
[the action hierarchy ticket](action-hierarchy-hides-primary-commands.md).

tradeoffs: one extra activation before naming; modal interruption instead of
popover positioning/focus complexity; create-and-open instead of batch creation
from the index. no launcher refactor or backend change is required.

acceptance: no idle creation row; direct keyboard/touch access; cancellation
returns to its trigger; validation retains the draft; uncertain retry creates
one library; success reaches the new library; the prior filtered/sorted index
remains recoverable. no application change or mutation verification in this review.
