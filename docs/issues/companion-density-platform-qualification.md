# companion density lacks native and contrast-theme qualification

the density case qualifies playwright firefox and chromium coarse-pointer
emulation. stock macos firefox's no-click-focus path is simulated by cancelling
mousedown; it is not a stock-browser run. forced colours were separately probed
in chromium, not checked in a real contrast theme. the reviewed screenshots use
the dark theme. no physical android webview or spoken screen-reader run exists.

impact: target geometry, off glyphs and focus semantics are measured in the lab,
but installed/native and assistive presentation remain unqualified. the android
apk owns delivery, so an installed app keeps its prior rows until rebuilt.

resolved when: the paired apk, stock firefox, contrast/light themes and spoken
controls are checked through their real user paths. chromium 110–117 is outside
the new documented 118+ browser floor, not a supported untested fallback.
