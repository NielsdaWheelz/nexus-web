# capped trailing actions retire the published local menu

lab35 `20261025-170315-6cc86ca6581e`, frozen `597`, owned-note menu case:
initial local actions publish above their trigger at a 400px viewport. delayed
server actions arrive, announce four more actions, then the menu disappears.
trigger remains fixed at y200.59375. diagnostic `capped-menu-publication.json`
records panel y25/height171.59375, trailing height88.59375/max107.594, panel
border-box max188.59375; after growth panel top becomes8 and it disconnects.

`ActionMenu.trailingRoom` subtracted integer inner scroll/offset heights from a
border-box cap, omitting two border pixels and fractional measurements. the
actual nonregion height is83px; the old calculation gave81px, allowing growth
past the cap and moving the supposedly frozen published rows.

repair measures the direct published block plus computed scroller padding and
borders in fractional CSS pixels. the existing immutable-row geometry guard
stays intact. exact source review and a fresh mounted case must prove delayed
server actions remain attached, published rows/focus stay fixed, and the actual
trailing viewport scrolls within its cap; then remove this issue.

independent mobile box control also confirmed that available-sheet backdrop
padding (24px by default) is outside the panel's 100% content-box height budget.
the same calculation now subtracts the backdrop's computed padding/borders and
uses fractional panel/scroller overhead. CSS-only flex allocation would require
special exceptions to collection constrained-mode scrolling; the existing
explicit measurement owner remains, with no guard or fallback-layout changes.
