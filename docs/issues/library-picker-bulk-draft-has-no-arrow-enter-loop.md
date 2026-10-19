# bulk draft library selection lacks the shared keyboard loop

status: open · origin: 2026-10-14 library picker design audit · area: web / imports, libraries

problem: bulk draft destinations use a separate interaction model from single-item destinations.

evidence: `apps/web/src/components/libraries/LibraryDestinationPicker.tsx:267-296` renders `LibraryChooser` for item selection, but `:298-385` renders a plain input and individual native checkboxes for bulk selection, with no arrow/enter handler. `apps/web/src/components/nexus/AddPanel.tsx:440-441` selects this branch for editable import items. source trace only.

reproduce: open libraries for editable import items, type a library name, then press down and enter. the single-item chooser's navigation/activation path is absent.

prerequisites: choose accessible mixed-membership semantics for none/some/all without inventing a mixed `aria-selected` value.

fix: give bulk and single-item pickers one query/navigation/activation owner; adapters supply membership and callbacks. from some, activation adds to all; from all, it removes from all.

acceptance: type, arrows, enter, repeat and escape work identically for draft row and bulk draft destinations; mixed state is visibly and accessibly distinguished from all and none.
