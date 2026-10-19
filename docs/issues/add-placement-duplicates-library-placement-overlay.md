# add placement duplicates the library placement overlay

status: open · origin: 2026-10-10 imports reauthor (cleanup/imports-reauthor) · area: web / add content, libraries

the Add session keeps its own per-media placement machine (`components/nexus/useAddContentSession.ts`: `readPlacement`, `writePlacement`, `runPlacement`, `retryPlacements`, ≈550 formatted lines with the panel's editor wiring) while the app's `LibraryPlacementOverlay` already solves single-target placement. Add needs multi-target placement ("Add all to…", "Remove all from…") with exact uncertain-change retry, which the overlay lacks, so the reauthor kept the machine (design T2).

2026-10-14 design audit: the shared owner should be the live placement command controller, above dismissible views. the ordinary overlay currently loses pending recovery on unmount; imports already retain it above the picker. sharing one visual overlay alone does not repair this. draft destination choices remain form state until import submission.

prerequisites: retain per-target eligibility, bulk target deduplication, exact uncertain-command recovery, and canonical inherited/default-library behavior. resolve [uncertainty lifetime](library-placement-new-edit-erases-uncertain-command.md) and [replay ordering](library-placement-retry-can-reorder-opposite-intent.md) in that owner.

fix: give ordinary and import saved-item editing one placement command owner, then delete their duplicate command machines. all draft and live adapters use one chooser interaction contract; draft selection does not acquire live write semantics.

acceptance: import row libraries, bulk add/remove and create-and-add use the shared owner; closing/reopening the picker retains outstanding recovery. manually verify these affected journeys under the current local testing standard; historical harness names do not reinstate the retired automated suite.
