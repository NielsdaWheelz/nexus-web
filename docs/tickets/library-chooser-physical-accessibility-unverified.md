# library chooser physical accessibility remains unverified

status: unverified · origin: 2026-10-15 chooser qualification · area: accessibility / devices

problem: no android handset was attached (`adb devices -l` was empty). native
computer control returned `cgWindowNotFound` for the exact task firefox/chromium
app paths and voiceover utility. actual speech and a physical soft-keyboard/ime
journey could not be observed.

impact: browser keyboard, focus, option descriptions and synthetic composition
guards passed across chromium, firefox and webkit. those checks do not establish
spoken clarity, physical composition, or keyboard persistence on a handset.
doubled-text screenshots are not native browser zoom; that manual visual check
also remains unobserved.

prerequisites/fix: use a working native screen-reader session and a handset against
the implemented chooser. reuse its disposable account and ordinary app paths;
no product test seam is needed.

acceptance: hear active action and confirmed membership as distinct facts; type,
compose, navigate, accept repeatedly, retarget and dismiss with an already-open
soft keyboard. input stays usable, the keyboard stays open through accepted edits,
and escape/back closes only the innermost surface. record the actual device and
speech output. inspect native browser zoom as well. see
[qualification](../library-chooser-verification.md).
