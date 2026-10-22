# initial action menu geometry retirement

a freshly opened library header menu can retire before its first command, while restored panes finish rendering. this preserves the menu's immutable-geometry guard but forces an immediate reopen during ordinary use.

observed in the real shared-controls lab: keyboard opening focused `Delete Library`, then `Library settings…`; enter closed the menu and announced `actions changed. reopen to see current options.` no command ran. `ActionMenu.tsx` snapshots geometry at publication and refuses later changes in `stable()`/`invalidate()`. the exact changing rectangle remains unisolated; fonts and surrounding pane layout are candidates, not established causes.

reproduce with several restored panes, navigate to a newly created empty library, and immediately open its header menu with arrow-up, arrow-up, enter. inspect native rectangle measurements around publication and activation. resolution requires identifying the movement and showing that a settled menu accepts its first command without relaxing geometry or meaning guards.
