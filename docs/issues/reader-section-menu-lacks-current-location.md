# reader section menu lacks current location

problem: opening the reader's chapter/section menu gives no current-row marker
and starts keyboard focus at the first or last row. in long documents, users
must rediscover their position after opening the navigation map.

evidence at `f0748d2b7`, under `apps/web/src/`:
`lib/documentReader/chrome/ReaderNavigation.tsx:33-36` derives the current section,
but `:55-68` does not carry it into the link/command descriptors.
`components/ui/ActionMenu.tsx:492-499,756-761` initializes focus at an edge.
player chapters already expose `aria-current`
(`components/player/PlayerPlaybackControls.tsx:128`) and desktop initial focus
targets it (`components/player/GlobalPlayerSurfaces.tsx:679`).

proposed fix: carry truthful current-location state into reader navigation,
visibly and accessibly mark it, and reveal it on ordinary open. preserve explicit
first/last keyboard requests, native links/modifiers, and reader-owned navigation;
do not substitute single-select semantics merely to obtain a selection marker.
ordinary action menus retain their own initial-focus contract.

resolved when opening a long document's menu makes the current section apparent
and visible, keyboard exploration does not navigate, and activation retains the
existing link/open-intent behavior. source review only; runtime verification is
not run. separate from the popup-height repair.
