# x share-menu keyboard qualification

when focus remains on nexus's disabled or refused share row, that row is absent
from the enabled menu items. the old arrow-up calculation used index -1 and
selected the penultimate native action, skipping the last action.

`apps/web/src/extension/xShare.ts` now explicitly selects the first enabled item
for arrow-down and the last for arrow-up when the focused item is not enabled.
ordinary navigation among enabled items retains its existing wrap behavior.

the correction passed independent source review. anonymous native menus are
reachable. qualify arrows from a disabled/refused nexus row and confirm native
actions remain reachable in order. do not force a refusal or mutate host nodes
to claim live qualification. ordinary menu activation is tracked separately in
[the current x menu issue](extension-current-x-dom.md).
