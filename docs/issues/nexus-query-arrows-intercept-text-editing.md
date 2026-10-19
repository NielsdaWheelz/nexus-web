# nexus query arrows intercept text editing

status: open
origin: 2026-10-14 navbar design review; source at `367da80e0c1beb1c426f6d2d72201b0733809b50`
area: nexus / desktop keyboard interaction

`apps/web/src/components/nexus/desktop/DesktopNexus.tsx:112–114` prevents the
default for left/right whenever the active result has a menu. it does not
distinguish query editing from grid-cell navigation or check modifiers. the
input keeps dom focus (`:74–93`), so caret movement, shift selection, and
platform word/line movement can instead change the virtual result cell.

reproduce: open nexus, type a query with an action-bearing active result, then
press left/right and their editing modifiers inside the query. inspect whether
the caret/selection moves or the result's actions cell changes. source-confirmed;
live reproduction is pending.

prerequisites: settle the editable-combobox keyboard contract. restore native
text editing in the query and preserve explicit access to result actions via
the existing command/control+k path and action buttons. if retaining grid-cell
navigation, give it an explicit interaction mode; typing must return to editing.
review modified up/down handling at `:106–111` in the same owner.

acceptance: caret, word/line movement and selection work after typing; result
up/down selection, enter activation, action-menu access and ime composition
still work. verify keyboard and assistive-technology behavior against the
[combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/).
