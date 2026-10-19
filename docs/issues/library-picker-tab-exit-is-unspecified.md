# library picker tab exit and portal continuation are unspecified

status: unverified · origin: 2026-10-14 library picker design audit · area: web / focus

problem: the nonmodal desktop picker has no explicit tab-exit policy. focus can leave according to portal order while the picker remains eligible to consume a later escape and restore its opener.

evidence: `apps/web/src/components/libraries/LibraryChooser.tsx:156-190` leaves tab untouched; `LibraryChooserSurface.tsx:67-75,125-138` registers a transient independently of focus and portals the panel. `apps/web/src/lib/ui/overlay.ts:215-231` handles only the enclosing modal's tab boundary; `:343-347` restores a transient opener unless dismissed outside. this is a source-derived verification gap, not an observed browser result.

prerequisites: choose logical continuation for the picker inside ordinary forms and the import modal. keep the existing overlay kernel as dismissal/focus owner.

fix: qualify and implement tab/shift-tab exit without selection or unwanted return focus, preserving accessible retry/action controls and the enclosing modal boundary. do not rely on the portal's physical position to define task order.

acceptance: tab moves through any explicit picker actions and then to the logical next control, dismissing when focus leaves; shift-tab exits backward; neither gesture changes membership. escape afterward belongs to the current surface, not an abandoned picker.
