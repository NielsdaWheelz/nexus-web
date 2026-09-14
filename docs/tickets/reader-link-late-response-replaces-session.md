# a completed link replaces a newer link session

- status: open
- origin: 2026-09-14 reader late-write review
- area: reader link composer

`useLinkComposer.ts:298` awaits a confirmed write, calls the current generic refresh callback, then unconditionally closes and clears the dialog. `close` does not cancel the committed operation, and `openLink` can install another source before its response returns. the older response can therefore close a newer dialog. a late failure likewise installs its frozen retry into the newer dialog. the body's boolean fresh-selection flag can then clear the newer source (`reader-selection-link-late-ack-selection-loss.md`).

preserve committed acknowledgment/undo. use the existing exact source/confirmed-intent identity to guard presentation updates, and deliver the completed source identity to the body callback. undo refresh must not masquerade as completion of whichever fresh selection is currently open. no second retry coordinator.

acceptance: hold a real link response; close, select another passage, and open a new link session; complete the older operation. the old acknowledgment survives, the newer dialog/selection remains, and a late old failure cannot install its retry there. verify the next confirm is not locked by the older finalizer.

actual composed red `b2d02c71957dff8d` fails `earlier Link response closed the replacement dialog`. reviewed green `6a74c25d6cbc46ac` preserves the replacement dialog/selection across both old success and lost-response failure, then accepts its next confirmation and clears only that source. retired failures use the existing persistent feedback owner; current failures stay in the current dialog. source identity plus endpoint comparison handles modal Range recapture; Undo refresh carries no current create identity. final canonical sensitivity and detached-DOM audit remain open.
