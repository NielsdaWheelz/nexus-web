# device auth state was not baselined before isolated login

status: open; final account identity unverified
origin: 2026-09-25 article-section-navigation physical offline verification
area: android device test hygiene / local user state

the isolated offline check signed the installed debug app into a disposable
account. before the check, the exact apk, foreground activity, network settings
and adb mappings were recorded, but the persisted auth session and native
offline-reading account binding were not. afterward the prior apk matched its
backup byte-for-byte, the original activity and network/mappings were restored,
and native storage held one binding with no packages or transfers. this cannot
establish that the final account binding or webview session matches the pretest
user state. cleanup did not clear app storage; the test sign-in may have replaced
the prior session.

prerequisite: establish the intended account identity from the device owner or
another trustworthy prior record before changing session state. do not infer
it from the disposable login or clear storage as a repair. future device runs
must capture a nonsecret identity fingerprint before sign-in and compare it
after restoration.

acceptance: the owner confirms or restores the intended account in the debug
app, and a later device run records matching pre/post session fingerprints.
