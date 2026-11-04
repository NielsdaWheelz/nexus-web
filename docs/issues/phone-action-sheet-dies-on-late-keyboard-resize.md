# a phone action sheet dies when the keyboard closes late

origin: 2026-11-01 annotation emptying qualification, android emulator · area: web
action menu (mobile)

tap `⋯` while the soft keyboard is up: the sheet opens, publishes, and closes with
`actions changed. reopen to see current options.` the user must tap again.

cause: dismissing the keyboard resizes the window. `ActionMenu.tsx` `resize` settles
admission while it lasts, but invalidates a visible sheet. admission ends 150 ms
(`MOBILE_ADMISSION_QUIET_MS`) after the last geometry change, which guesses how long a
keyboard takes to close. a resize that lands later kills the sheet with its anchor
unmoved. `docs/modules/overlays.md` says the quiet interval does not assert keyboard
completion and that resize retirement stays strict, so a fix changes a qualified
contract.

evidence: emulator api 35, webview 124, gboard 14.2. passive probe, times from focus
entering the sheet: resize at 25-150 ms never killed (48 taps); resize at 159, 161,
187, 196, 206, 223, 226, 287, 377 and 424 ms killed all ten. baseline `5b582fd68` 2 of
21 taps; with annotation emptying 2 of 24, then 2 of 5 and 3 of 5 on emulators beside
other labs; cold boot 2 of 2 (resize at 458 ms). no same-boot baseline was taken, so
whether load or the change moves the rate is unmeasured. twice the downloaded shelf
reader's header `⋯` died with the same status and no keyboard up (labs
20261101-230748-3251a1ab5df1, 20261102-111154-a73ab3af2d50); unmeasured. handsets not
observed.

resolved when a tap with the keyboard up publishes a sheet that survives on a cold
boot, and a sheet whose anchor really moved is still retired.
