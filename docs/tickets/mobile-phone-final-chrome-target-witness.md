# final chrome target preservation check is unavailable

status: open
origin: 2026-10-16 mobile palette physical qualification
area: device verification / chrome cdp

each task-owned chrome incognito context closed with both original page targets
preserved. later, adb lost all mappings without the debug app pid changing;
the original mappings were restored. the final `connectOverCDP` to baseline
52905 fails with `socket hang up`, although `/proc/net/unix` lists
`chrome_devtools_remote` and chrome pid 7344 exists. no chrome force-stop,
installation, default-tab navigation or account change was performed.

the original debug apk and 110 archived data entries compare identically after
restoration; baseline mappings and rotation compare identically too. find owns
the next phone window and was sent the two original target ids privately.

do: use the current owner's ordinary cdp connection to verify the original
targets remain, without navigating their tabs. no extra phone lease is needed.

acceptance: that observation is recorded, or document why exact identifiers
cannot be checked while confirming the user's tabs/account remain intact.
