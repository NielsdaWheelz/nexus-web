# web drops MakeArtifactRevisionCurrent until the backend with 0250 ships

status: open · origin: 2026-09-28 cleanup pr-08 (cleanup/dossier-latest-revision) · area: resource actions web

pr-08 deletes revision history and Make current. the web deploys first, and the
pre-0250 backend still offers `MakeArtifactRevisionCurrent` on every visible
superseded revision. the strict snapshot decoder throws on an unknown capability
kind, and the action runtime raises that defect into the authenticated shell, so
one evidence row citing an old revision would take down the workspace.
`apps/web/src/lib/actions/resourceActionSnapshot.ts` (`decodeResourceActionCapability`)
therefore decodes that kind and returns `null`, and `decodeResourceActionSnapshot`
filters it out.

prerequisite: a backend release that includes 0250.

fix: delete the `MakeArtifactRevisionCurrent` arm, the `| null` return and the
`.filter`.

acceptance: `rg MakeArtifactRevisionCurrent apps/web/src` finds nothing, and
`decodeResourceActionCapability` returns `ResourceActionCapability`.
