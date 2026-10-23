# offline startup release

pair the installed-workspace bff/web and android apk; retire native hosted-root
startup and old handoff/bridge contracts
together. wire 15 follows released wire 14; keep this bump for subsequent breaking changes
until the next release. no database migration or new environment variable.

before installing, save or explicitly discard open authoring: an apk update
cannot preserve memory-only drafts. pause playback and drain pending native
progress where possible; preserve the existing download namespace and pending
records through upgrade. the first launch needs one online verification of the
same account to provision the new startup record. never silently delete another
account's namespace or overwrite corrupt state with defaults.

package all ui chunks, fonts, images and pdf.js assets from the paired source.
pass the paired server’s existing `R2_S3_API_ORIGIN` into the apk build; it seals
the installed upload csp allowlist.
verify ordinary assets cannot fall through to remote fetching. give the installed
build clear manual apk-update instructions; add no distribution service or
automatic updater. wire mismatch must not offer a reload loop.

the implementation pr owns emulator qualification and its exact limits. before
release, qualify the physical phone: cold airplane-mode launch after force-stop,
acknowledged navigation, cookie durability, same-account sign-in preserving open
text, offline sign-out, downloads exit/return and ordinary online journeys. run
successful google/github sign-in and identity linking with configured providers.

resolved when the paired cutover and these journeys are qualified. episode
offline playback, catalog and reading parity are separate releases.

owner dispositions: physical-device qualification and successful google/github
sign-in and identity linking are deferred to release. this change qualifies the
shared real password
handoff and provider refusal/cancellation boundaries. retain the released writing
journal; apk-update draft warnings concern other memory-only forms.
