# reader sidebar removal needs same-visit verification

same-visit deletion and local unlink focus recovery were not completed before
host disk exhaustion ended the live campaign. the isolated resources have since
been removed. this is an unverified acceptance case, not an observed defect.

`EvidencePane.tsx` supplies checked-radio/first-mobile-type recovery through its
row mutation callback. verify both local unlink and a global highlight delete
after first landing on that exact highlight's activation href. assert the visit
and radio identity remain unchanged; otherwise the test is navigation rather
than row removal. see [the separate finding](reader-sidebar-removal-focus-recovery.md).

resolved when removing the owned focused row restores the checked radio or first
mobile type without scrolling the source or stealing attention after the user
has focused elsewhere.
