# outline redesign release hold

release and deployment remain on hold until the owner’s other pending prs have
merged. merging the outline correctness follow-up does not authorize deployment.

the outline changes require no wire bump, schema migration or android native
change. hosted web can ship independently; android receives the bundled frontend
only with the next apk. a hosted hotfix does not update an installed apk.

before regular phone editing on that apk, qualify one focused journey with a
disposable note: type, held backspace at an item boundary, bullet drag, hold for
menu, tap to open, and back. retain the separate physical-input limits in
[outline range native input](release-outline-range.md) and the exact
[android journey blocker](outline-android-touch-journey-unproven.md).

resolved when the other prs have merged, the owner authorizes and performs the
release, and the paired apk’s focused phone journey is observed or explicitly
dispositioned. deployment evidence belongs in the release pr.
