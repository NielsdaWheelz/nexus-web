# android native selection regrab can move the other endpoint

native app qualification on `887099923` observed an epub selection with offsets
180..0. regrabbing its end handle changed the opposite endpoint from 0 to 2375
before movement. reversing the start back to offset 4 instead preserved the
opposite endpoint on regrab. this can make the browser's visible selected quote
jump. nexus captures the resulting range, not an older requested range.

evidence: samsung sm_s906w/android 16, webview 155.0.8059.43, isolated disposable
app. repeatable native adb handle gestures; screenshot
`nexus-native-before-big.png` and probe output are retained under
`~/.local/state/nexus-verification/mobile-selection-20261023/local/`. the
reader has no native range mutation or source-dom rewrite in this flow.

chromium reconstructs both endpoints from handle positions on drag begin
([source](https://chromium.googlesource.com/chromium/src/+/8416edfaa1897b4539949829dccb52a9c7dab992/ui/touch_selection/touch_selection_controller.cc#477)).
a coordinate-resolution problem is plausible, not established. reproduce with
ordinary physical gestures and a plain html control before attributing this to
the engine or altering product code. resolved when selecting from the first
character, reversing and regrabbing either handle leaves the untouched endpoint
stable on both qualified android environments. no guessed coordinate correction
or scripted native-range reconstruction.

runtime `afea0af8b`: native app pdf reversal/regrab and large save passed;
chrome 155.0.8059.84 continued a held pdf drag from 7 to 151 to 271 characters,
but subsequent reversal/regrab did not consistently hit the intended boundary.
raw pdf selection endpoints sometimes named text-layer element boundaries rather
than text nodes. chrome's incognito screenshot excludes native handles, so the
probe cannot settle whether this is input targeting or browser behavior. keep
chrome pdf reversal/regrab unqualified until physically observed; do not infer a
product fix from these coordinates. private final probe log:
`nexus-native-large-chrome-pdf-final.log` in that same private directory.
