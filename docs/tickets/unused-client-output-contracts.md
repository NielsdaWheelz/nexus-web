# unused client output contracts

status: open · origin: 2026-10-04 simplification audit at `765f335aed06795ef2b3be7031dd4ebb02c04f22` · area: web transport

`apps/web/src/lib/conversations/chatFailureContract.ts` is a 54-line closed
failure decoder with no imports or callers. `apps/web/src/lib/media/mediaActionCapabilities.ts`
is a three-line generated-schema alias with no consumers. repository-wide imports,
symbol uses and explicit app/extension/offline entrypoint registrations were traced;
neither lib file is a framework entrypoint. both duplicate already owned contracts.

delete the unused files in a later scoped cleanup. preserve the live generated
failure/capability contracts and their genuine domain projections. acceptance:
source has no callers or registration references, and `./scripts/test` passes
after deletion. no observed user defect or runtime saving is claimed.
