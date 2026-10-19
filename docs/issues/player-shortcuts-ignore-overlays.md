# player shortcuts ignore overlay ownership

status: open · origin: 2026-10-14 shortcut-removal review · area: web / player, overlays

`apps/web/src/lib/player/playerRuntime.tsx:455-483` dispatches space and arrow
shortcuts without consulting the overlay owner. its editable and interactive
target guards do not exclude a dialog panel with `tabIndex=-1`.
`apps/web/src/components/libraries/LibraryChooserSurface.tsx:140-147`
explicitly focuses its mobile sheet panel, so that target is reachable.
`docs/modules/overlays.md` assigns global commands to the active overlay.

impact: a loaded player can pause, seek or change tracks while the library
chooser owns the interaction. this is source review, not a device reproduction.

prerequisites: loaded playback and a mobile viewport with a hardware keyboard.
reproduce: open the library chooser, leave initial focus on its sheet, then
press space and arrow keys. fix: make the global player handler yield while
an overlay owns interaction; keep explicit player controls operable.

acceptance: those keys leave playback unchanged while the sheet owns focus;
existing player shortcuts work after dismissal and still yield to editing and
interactive controls.
