# collection documentation references absent contracts

status: open
origin: 2026-09-21 quick-reads council; updated during quick-reads implementation
area: library / lectern documentation

## problem and evidence

`docs/cutovers/` is absent, but `docs/modules/player.md:16–26` still delegates
behavior and presentation to deleted lectern lifecycle, resonance reading-slate,
android playback/protocol and lectern editorial contracts.
`docs/modules/library.md:349–350` still links the deleted entry-view-continuity
contract. the same module docs retain absent placement, universal-link,
browse and offline-reading references.

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
