# reader sidebar global deletion needs same-visit verification

same-visit global highlight deletion was not completed before host disk
exhaustion ended the original live campaign. the original isolated resources
have since been removed. this is an unverified acceptance case, not an observed
defect.

`EvidencePane.tsx` supplies checked-radio/first-mobile-type recovery through its
row mutation callback. local unlink was verified during integration with
`d6f04890c`: removing the last machine-link row kept the source visit and scroll
position and focused the checked desktop radio or first mobile item type.
desktop and mobile focus moved elsewhere during a held acknowledgement was
preserved.
verify a global highlight delete
after first landing on that exact highlight's activation href. assert the visit
and radio identity remain unchanged; otherwise the test is navigation rather
than row removal. see [the separate finding](reader-sidebar-removal-focus-recovery.md).

resolved when global highlight deletion restores the checked radio or first
mobile type without scrolling the source or stealing attention after the user
has focused elsewhere, in the same visit.
