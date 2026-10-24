# client releases omit signed firefox installers

problem: the [manual signing procedure](../../apps/extension/README.md) exists,
but `apps/web/scripts/build-extension.mjs` produces an unsigned directory and
the normal client release publishes only `nexus-capture.zip`. it does not own
extension version increments, signing and signed-installer publication.

impact: a future native-client release can omit the installable firefox
artifact. mozilla now holds version `1.0.0` for wire 14, but
`apps/extension/manifest.json` still declares that version while main's
`apps/web/src/lib/api/wire.gen.ts` uses wire 15. a changed payload needs a new
extension version.

resolved when the client release has an explicit owner for versioning,
unlisted signing, reviewer source and signed-installer publication; its source,
wire and production origins match the qualified release, and an update installs
persistently. signing credentials stay outside the repository.
