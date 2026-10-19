# native phone selection and ime need device qualification

status: open · origin: 2026-10-15 selection composer acceptance · area: reader / native input

desktop native selection/focus passes chromium, firefox and webkit. this host
has no attached android device (`adb devices -l` empty); `xcrun xctrace` is
unavailable. chromium touch emulation did not produce native long-press
selection even on plain text. it cannot prove phone selection handles or os ime.
native desktop ime also remains unverified; mounted editor proof used synthetic
composition flags.

2026-10-19: isolated nexus android qualification on samsung sm-s906w,
android 16 / webview 155.0.8059.43 verifies native long-press, handle extension
and selection clearing in text and pdf. this does not qualify ime or ios;
see `pdf-selection-composer-covers-native-handles.md` for an obstructed pdf case.

prerequisite: an authenticated android device and ios device using the matched
web/api build. select text/pdf with native handles; extend the range; tap the
composer; type with the keyboard and ime. verify viewport containment,
shift-enter, save/chat shortcuts, and that composition/repeats never delete.
return from chat and reopen the passage to check rich draft/caret retention.

acceptance: record actual devices/os/browser versions and all observations in
the closing pr body; no emulation substituted for device
proof. see also the existing android reader/notes qualification tickets.
