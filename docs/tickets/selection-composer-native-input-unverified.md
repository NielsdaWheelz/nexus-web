# native phone selection and ime need device qualification

status: open · origin: 2026-10-15 selection composer acceptance · area: reader / native input

desktop native selection/focus passes chromium, firefox and webkit. this host
has no attached android device (`adb devices -l` empty); `xcrun xctrace` is
unavailable. chromium touch emulation did not produce native long-press
selection even on plain text. it cannot prove phone selection handles or os ime.
native desktop ime also remains unverified; mounted editor proof used synthetic
composition flags.

prerequisite: an authenticated android device and ios device using the matched
web/api build. select text/pdf with native handles; extend the range; tap the
composer; type with the keyboard and ime. verify viewport containment,
shift-enter, save/chat shortcuts, and that composition/repeats never delete.
return from chat and reopen the passage to check rich draft/caret retention.

acceptance: record actual devices/os/browser versions and all observations in
`docs/selection-composer-verification.md`; no emulation substituted for device
proof. see also the existing android reader/notes qualification tickets.
