# add placement duplicates the library placement overlay

status: open · origin: 2026-10-10 imports reauthor (cleanup/imports-reauthor) · area: web / add content, libraries

the Add session keeps its own per-media placement machine (`components/nexus/useAddContentSession.ts`: `readPlacement`, `writePlacement`, `runPlacement`, `retryPlacements`, ≈550 formatted lines with the panel's editor wiring) while the app's `LibraryPlacementOverlay` already solves single-target placement. Add needs multi-target placement ("Add all to…", "Remove all from…") with exact uncertain-change retry, which the overlay lacks, so the reauthor kept the machine (design T2).

fix: in the libraries rewrite, give the shared overlay multi-target placement with per-target uncertain retry, then delete Add's machine and render the overlay (≈−500 lines from Add).

acceptance: Add's row Libraries, Add all to…, Remove all from… and create-and-add run through the shared overlay; harness A7 and A20 pass unchanged.
