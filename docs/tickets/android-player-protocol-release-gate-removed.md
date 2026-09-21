# the Android player-protocol release gate has no owner

status: open · origin: 2026-09-21, deploy collapse · area: release · oi-174

## evidence

the previous `deploy/hetzner/deploy.sh` read GitHub's `releases/latest`, required
it to be one stable signed `android-v*` release carrying `release-manifest.json`,
`nexus-android.apk` and its `.sha256`, and required that manifest's player
protocol to equal `contracts/android-player-protocol.json`. that refused a
web/backend release whose player protocol had moved away from the APK users
actually have installed.

the collapsed `deploy.sh` keeps only the cheap half: the staged and public
frontend `/version` must serve this tree's `player_protocol`. nothing now
compares the release against the published APK, so a protocol bump can ship
while the latest stable Android release still speaks the old one.

## impact

installed Android clients can break on a web release with no release-time
signal. the protocol version is deliberately slow-moving (currently 2), so the
window is narrow, but it is unguarded.

## next action and acceptance

either re-add the check where it belongs — most naturally in the Android
release lane, which knows when the protocol moves — or accept the gap
explicitly and record the compatibility rule the operator applies by hand.

accept when bumping `contracts/android-player-protocol.json` cannot reach
production while the latest stable Android release speaks the prior version,
or when that rule is written down as an operator step with a named owner.
