# dropdown native input qualification

the unified searchable pickers change candidate selection, membership marks and
keyboard admission. physical ime, handset touch/soft-keyboard and spoken assistive
qualification are `NOT_RUN`; browser emulation does not establish those inputs.

available-height action sheets additionally need physical keyboard/safe-area
qualification, including nonzero ios visual-viewport pan. browser visual zoom
does not establish handset keyboard geometry. verify the top gap, a reachable
close control and one scrollport within the unobscured viewport.

source: `lib/ui/searchOptions.ts`, `components/ui/Collection.module.css` and their
library, people, author, reference, chat and launcher adapters under `apps/web/src/`.

resolve by driving composition, arrows, held enter and touch scrolling on the
supported physical clients. hear the current candidate/action, confirmed versus
chosen membership, mixed/unavailable state and one progress announcement. verify
that the soft keyboard leaves search, results, recovery and close reachable.
