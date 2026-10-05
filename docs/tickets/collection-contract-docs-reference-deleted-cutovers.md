# collection documentation references absent contracts

status: open
origin: 2026-09-21 quick-reads council; updated during quick-reads implementation
area: library / lectern documentation

## problem and evidence

`docs/cutovers/` is absent, but `docs/modules/player.md:16–26` still delegates
behavior and presentation to deleted lectern lifecycle, resonance reading-slate,
android playback/protocol and lectern editorial contracts.
`docs/modules/library.md:349–350` still links the deleted entry-view-continuity
contract. the same module docs retain absent universal-link, browse and
offline-reading references.

source audit at `031c3c95de81f25306b4e17fd656d9eeaf72218c` also found
`docs/modules/library.md:448–451` naming `library_destinations:v2` and v2-only
acceptance, while `python/nexus/services/library_governance.py:603` owns
`LibraryDestinations:v3`. update that description to the actual cursor owner;
no runtime failure is claimed by this documentation drift.

quick reads corrected the reading-time owner in architecture and module docs,
documented current duration/slate behavior, and removed library-sorting links.
the collection-controls change corrected the media-metadata link to the deleted
original-publication cutover and rewrote the affected workspace and pane-search
contracts. those completed changes do not resolve the remaining delegated
player and library contracts.

## prerequisites and proposed fix

check which decisions survive reauthoring. document current constraints in their
owning modules and replace the remaining obsolete references with existing
contracts. do not restore deleted historical plans wholesale.

## acceptance

library and lectern module documentation points to existing current contracts;
no behavior or presentation rule depends on an absent cutover file.
