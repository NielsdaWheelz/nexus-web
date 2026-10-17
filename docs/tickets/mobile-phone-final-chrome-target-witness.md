# original chrome target ids changed during phone qualification

status: open
origin: 2026-10-16 mobile palette / find phone handoff
area: device verification / chrome state

each mobile-owned chrome incognito context closed with both original page
targets preserved. later adb lost every mapping without the debug app pid
changing. mappings were restored; final baseline-cdp connection hung up despite
`chrome_devtools_remote` existing and chrome pid 7344 running.

find's next ordinary cdp connection succeeded. BEFORE creating any own context,
both original ids were absent: `26F6CC3D5F1DFAAE332D2025B29C4A92` and
`F438089E1651E57BE755F80788009EDC`. find's entry targets survived its first own
context closure. no participant reported chrome force-stop, installation,
default-tab navigation, account changes or baseline mapping changes in that window.

impact: final preservation of the user's actual chrome tabs/account is not
established by the earlier id checks. the cause of the identifier change is
unknown; the original chrome process id was not recorded. do not infer lost
user data from opaque ids alone or claim the final check passed.

separate verified restoration: original debug apk and 110 archived data entries
compare identically by bytes/modes/types/symlinks; mappings and rotation match.

next: the current owner can confirm the original tabs/account through ordinary
observation. record any browser restart explaining changed ids if known; never
reconstruct private tabs, reset chrome or manufacture ids to satisfy a check.

acceptance: actual user state is confirmed intact and identifier churn explained,
or an observed user-state loss has a concrete recovery owned by the user.
