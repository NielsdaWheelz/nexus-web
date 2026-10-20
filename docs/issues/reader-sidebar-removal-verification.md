# reader sidebar global deletion needs same-visit verification

same-visit global highlight deletion was not completed before host disk
exhaustion ended the original live campaign. the original isolated resources
have since been removed. this is an unverified acceptance case, not an observed
defect.

local unlink passed with `d6f04890c`: last-row removal preserved the source
visit/scroll and used the checked desktop radio or first mobile type. later
reader integration `5b9949e7` replaces per-group lists with one stable outline;
nested relationship removal uses that shared list’s stable focus fallback.
desktop/mobile checks passed after the accepted map removed the whole grouped
root; delayed acknowledgement preserved intervening focus. neither local check
qualifies global resource deletion.

verify a global highlight delete after first landing on that exact highlight's activation href. assert the visit
and radio identity remain unchanged; otherwise the test is navigation rather
than row removal. see [the separate finding](reader-sidebar-removal-focus-recovery.md).

resolved when global highlight deletion restores the checked radio or first
mobile type without scrolling the source or stealing attention after the user
has focused elsewhere, in the same visit.
