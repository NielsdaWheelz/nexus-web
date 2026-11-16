# wire 24 installed client acceptance

the owner authorized the paired release on 2026-11-15 and explicitly chose
“defer installed-client checks for this release”. android 0.3.16/code 37 and
firefox 1.1.4 must use the released source and wire 24. this deferral covers
publication after paired deployment and packaged-byte checks pass.

in-place upgrade, retained login and writing, app links, offline-to-online
reconnect, and firefox's persistent signed update and real capture remain
unobserved. preserve existing storage; never uninstall or clear state to qualify.
resolve when those installed journeys pass and their scope is recorded in the
release pr. this is no waiver for a later release.
