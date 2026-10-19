# native phone selection and ime need device qualification

status: open · origin: 2026-10-15 selection composer acceptance · area: reader / native input

earlier desktop native selection/focus passed chromium, firefox and webkit.
chromium touch emulation did not establish native phone handles or os ime;
that evidence remains distinct from device qualification.

2026-10-19: isolated nexus android qualification on samsung sm-s906w,
android 16 / webview 155.0.8059.43 verifies native long-press, handle extension
and selection clearing in text and pdf. this does not qualify ime or ios;
see `pdf-selection-composer-covers-native-handles.md` for an obstructed pdf case.

resource insertion qualification on the attached samsung also passes actual
chrome composition, committed `@`, touch acceptance, touch-pan cancellation and
narrow popup containment against the isolated api. desktop text/pdf native
selection passes atomic highlight-plus-link insertion with the captured reader
generation. this does not qualify an installed android shell, a physical system
keyboard's ime or ios. the owner waived talkback/accessibility qualification for
this cutover; it is not an outstanding acceptance requirement.

prerequisite: an authenticated android device and ios device using the matched
web/api build. select text/pdf with native handles; extend the range; tap the
composer; type with the keyboard and ime. verify viewport containment,
shift-enter, save/chat shortcuts, and that composition/repeats never delete.
return from chat and reopen the passage to check rich draft/caret retention.

acceptance: record actual devices/os/browser versions and all observations in
the closing pr body; no emulation substituted for device
proof. see also the existing android reader/notes qualification tickets.
