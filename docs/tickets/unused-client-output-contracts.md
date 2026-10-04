# unused media capability alias

status: open · origin: 2026-10-04 simplification audit at `765f335aed06795ef2b3be7031dd4ebb02c04f22` · area: web transport

`apps/web/src/lib/media/mediaActionCapabilities.ts` is a three-line
generated-schema alias with no consumers. repository-wide imports, symbol uses
and explicit app/extension/offline entrypoint registrations were traced; this
lib file is not a framework entrypoint. the live generated contract already
owns its shape. the chat finding is tracked separately in
[its ownership ticket](chat-failure-contract-has-parallel-browser-owner.md).

delete the unused alias in a later scoped cleanup. preserve the live generated
capability contract and its genuine domain projections. acceptance:
source has no callers or registration references, and `./scripts/test` passes
after deletion. no observed user defect or runtime saving is claimed.
