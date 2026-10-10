# the action bar's popover action has no producer

status: open · origin: 2026-10-10 overlay kernel reauthor (cleanup/overlay-kernel-reauthor) · area: web / ui

`components/ui/ActionBar.tsx` renders a `kind: "custom"` header action as a
`PopoverAction`: a trigger and a `FloatingActionSurface` holding the action's
custom controls. no surface publishes a custom header action
(`PaneHeaderAction` producers: podcasts and conversations, both `link`), so
the popover is unreachable. it was the one path by which a floating surface
could open inside a modal (a header in the mobile secondary-pane sheet); the
overlay harness's design journey O13 (a floating surface inside a modal renders
in the modal's panel, keeps Tab and takes Back first) therefore has no product
path and is unpinned.

what to do: delete `PopoverAction` and the `custom` arm of the header action
type, or ship the feature that needs it and pin O13 with it.

resolved when: the popover is gone, or a product surface uses it and the
harness pins O13.
