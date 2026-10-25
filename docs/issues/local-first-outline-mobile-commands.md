# local outline mobile commands

local-first cutover replaced `components/notes/OutlineSurface.tsx` with `LocalOutline.tsx`, but the replacement does not publish `PaneOutlineCommands`. `PaneShell.tsx` renders its existing mobile insert/indent/outdent/move/undo/redo accessory only from that publication. keyboard handlers alone do not preserve touch access.

restore publication from the interacting local outline and its actual history/selection owner. resolved when the existing accessory performs these local commands on mobile, including undo after structural changes.
