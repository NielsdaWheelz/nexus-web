# offline catalog release

pair the catalog endpoint/web and android apk from the same source. the route is
additive: retain wire 15 under the existing release rule. there is no migration,
new environment variable or server export job. existing startup release checks
remain in `release-offline-startup.md`.

before release, qualify the signed installed upgrade against production: save a
complete catalog for the actual account, force-stop, enter airplane mode and open
previously unvisited library/podcast/note/chat indexes and detail boundaries.
verify foreground/manual refresh, retained freshness after failure, and sign-out
cleanup. preserve installed downloads, pending progress and the writing journal
through upgrade; save memory-only drafts before replacing the apk.

old catalog format/wire is rebuilt online, never migrated through a compatibility
reader. catalog failure must leave the shell and unrelated stores usable. full
refreshes may use mobile data while the app is open. this release adds metadata
browsing, not episode downloads or reading/playback parity.

resolved when the paired signed upgrade and production-account journeys pass.
isolated-device implementation proof belongs in the implementation pr.
