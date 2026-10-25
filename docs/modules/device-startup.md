# installed android workspace

the apk owns ordinary interface delivery. `AppRouter` serves installed html,
lazy chunks, fonts and static assets at the configured owned origin, regardless
of connectivity. next owns hosted delivery and the same-origin bff. both builds
use the same workspace, pane controllers and resource owners.

debug defaults to `https://127.0.0.1:3000`, reached through adb reverse.
`nexusAndroidDebugCaFile` optionally generates debug-only trust for the exact
owned host alongside system roots. the custom-tab browser establishes its own
trust; apk trust does not provision that browser. release uses normal system
trust. the [canonical web edge](../local-rules/codebase.md#web-production-build)
requires http2; packaged assets retain their local delivery below.

## ownership

`DeviceSession` is the native account authority. one private `AtomicFile` holds
`{format_version:1,binding}`. a binding contains confirmed account/time zone,
reader profile, canonical workspace and its decimal-string local revision.
absence means unprovisioned; null binding means deliberate sign-out with
idempotent cleanup required. unreadable state is an explicit error and retains
its bytes. offline/media/player stores carry namespace tags, not account authority.

local startup mounts an existing binding before remote verification. first
provisioning imports the workspace selected by the existing server model.
later bootstrap refreshes account/profile while local navigation remains
authoritative. no corpus or server read results enter the startup record.
[authored writing](notes.md) owns its separate account database, pending changes
and local autosave; unsubmitted annotation composers remain ephemeral.

state/file access is serialized off the main thread, never locked over networking
or cookie callbacks. a workspace commit merges into the current record and
acknowledges durable publication before advancing its revision. one client save
owner retains the latest desired state; an uncertain reply is reconciled by
reading committed state. a kill can lose unacknowledged navigation.

## delivery and local protocol

`/_nexus/app/` owns immutable installed assets; a reserved miss terminates locally.
`/_nexus/device/startup.json` returns 200 with the committed envelope, 204 when
absent, or an explicit local-state error. auth/api/public documents retain their
network routes. downloaded documents stay on the shelf's isolated origin.
response policy comes from the shared security owner; local documents receive
fresh nonces. browser-supplied owned-origin referrers distinguish incoming app
subresources before the page-start callback; outgoing shelf requests remain
isolated during that transition.

`nexusApp` uses existing exact-origin, main-frame, document-scoped web messages.
hello observes session state. fixed operations check/sign in/sign out, manage
account settings and commit a workspace using begin/ordered chunks/commit.
24 kib raw chunks fit the 64 kib frame boundary without limiting workspace size.
document/account exit retires its upload and replies. javascript cannot bind an
account or select an arbitrary native request/file path.

## remote admission and credentials

checking, ready, unavailable, sign-in-required and update-required describe
remote admission separately from local access. only verified bootstrap admits
remote work. cold bodies and eager effects wait; previously admitted owners keep
their data, text, cursors and pending identities. ready resumes reads and each
existing command owner's retry rules.

ordinary android bff calls authenticate but never rotate or clear cookies.
the existing android user-agent marker selects renewal policy, not authorization.
the native credential owner serializes bootstrap, handoff and fixed settings
operations, checks lifetime before cookie effects and awaits installation/flush.
foreground, reconnect, job entry, 401 and the server's ephemeral renewal deadline
trigger coalesced verification.

custom-tab/password/oauth and native google sign-in reuse the one-use handoff.
native owns the current verifier; redemption verifies the expected account before
publishing cookies. canceled or superseded attempts cannot install credentials.
the mounted workspace survives same-account sign-in. hosted account management
checks the expected account in the separate browser context.

explicit sign-out resolves the existing writing/work guards, closes remote
admission and retires credential effects. native checkpoints/stops playback,
persists null binding and completes local purge/credential clearing. interrupted
cleanup repeats before another account is exposed. remote revocation is bounded
best effort; offline sign-out does not wait for a server. downloads navigation
opens an ordinary workspace pane. opening a non-episode reading copy exits to
the isolated shelf through the writing guard.
