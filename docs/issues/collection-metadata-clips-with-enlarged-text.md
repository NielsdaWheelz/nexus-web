# collection metadata clips with enlarged text

status: open
origin: 2026-10-14 quick-read live qualification
area: shared collection layout / accessibility

at a 320px viewport and 200% text, quick-read titles truncate and reading
metadata clips mid-word. observed in the
enlarged-text screenshot retained in #604.
the final scoped add label fits.

the shared rules predate this change:
`apps/web/src/components/ui/ResourceRow.module.css:7,86,208`
retains fixed tracks, rem padding/gaps and title clamping;
`apps/web/src/components/collections/CollectionRow.module.css:81` makes reading
facts nonwrapping; `apps/web/src/components/ui/PaneSection.module.css:1,55`
clips overflow and adds rem padding.
at that qualification these rules were unchanged from `b6768bee2`; baseline
geometry was not rerun live.

2026-10-21 podcast artwork qualification reproduced this in firefox 158.0.1
with actual text-only zoom at 200% and full-page zoom at 100%, at 320px and
390px. artwork stays 44px and controls remain reachable, but at 320px the
opening bullet consumes a title line and `Alpha Transparent` can show only
`Alp`; metadata also clips. the owner explicitly retained compact truncation
for the artwork change. this issue remains open; that qualification does not
establish complete text readability.

reproduce: open lectern with short articles, use a 320px viewport, enlarge
text to 200%, then inspect quick-read title and remaining-time lines.
prerequisites: agree the shared row's narrow text reflow contract.
fix at the shared row/layout owners and check other collection surfaces.
acceptance: enlarged text retains complete reading facts without clipping or
horizontal page overflow; titles retain a usable navigation/disclosure surface.
