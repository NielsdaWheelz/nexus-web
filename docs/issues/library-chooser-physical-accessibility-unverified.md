# library chooser physical accessibility

status: unverified
origin: 2026-10-15 library chooser qualification
area: keyboard / accessibility

browser checks cover focus, native repeated enter, modified editing keys,
tab/shift-tab, narrow keyboard invocation and a synthetic composition guard.
they do not prove physical ime input, screen-reader speech, a phone soft keyboard
or native browser zoom. the earlier native-control attempt returned
`cgWindowNotFound`; no handset is attached. macos also denied physical popup-host
escape (`osascript is not allowed to send keystrokes`, 1002). marionette escape
did not reliably close the host; explicit host dismissal proves close/reopen
lifecycle only. installed firefox checks do not establish those separate inputs.

acceptance: drive type → arrow → enter repeatedly with a physical keyboard/ime,
hear active action and confirmed/pending membership with a screen reader, and
check narrow sheet/inline layouts with a soft keyboard and native zoom. retain
exact observations; fix any focus loss, clipping or misleading speech. confirm a
physical escape closes the native extension popup and reopening shows its current
capture.
