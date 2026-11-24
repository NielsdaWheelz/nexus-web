# journal recorded-day speech on android

actual talkback speech still needs qualification for both work-only days and
empty saved pages. on packaged `d046d7575`, talkback 14.2 was active with the
webview's base application window focused and the keyboard closed. it focused
november 16 in the grid, then lost the grid after sending an enter chord. the
full audio speaks the date without its mark and has no attributed focus
interval. `takeover-android-reconnect-d046d75-033111/android.json` and
`talkback-unattributed.json` hold those observations.

at `15e15f096`, talkback audibly said `recorded day` for the empty saved
november 15 page. the november 16 work-only clip names the date but does not
contain the mark. the chooser stayed open with the expected button and marked
label focused in both intervals. see `takeover-android-15e15f0-034630/android.json`
and `talkback-spoken.json`.

resolve with the real date chooser on the owned emulator. verify the displayed
month, reach each marked day through talkback, and capture both spoken labels.
