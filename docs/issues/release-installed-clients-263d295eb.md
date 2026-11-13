# installed client acceptance for 263d295eb

on 2026-11-13 the owner authorized publication after paired deployment passes:
“publish; defer installed-client checks for this release”. this covers android
0.3.15/code 36 and firefox 1.1.3 from `263d295ebeda5849cd8114725f0a1dbaf5cead41`,
wire 23. signing and packaged-byte checks do not establish installed behavior.

no physical handset is connected. in-place upgrade, retained login and writing,
app links, and offline-to-online reconnect remain unobserved. firefox's persistent
signed update and real capture remain unobserved. feature observations remain
with their existing release issues, including [selection](release-lit-rule.md),
[running head](release-running-head.md) and [leaves](release-librarian-leaves.md).

this is no waiver for later releases. preserve existing storage and writing;
never uninstall or clear state to make qualification pass. resolve when the
installed journeys pass and their actual scope is recorded in the release pr.
