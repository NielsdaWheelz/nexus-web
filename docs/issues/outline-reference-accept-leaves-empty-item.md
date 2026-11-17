# accepting a reference can leave an empty item above it

reported at `839bb918b` on 2026-11-16: typing `@` into an empty outline item and
accepting a result left an empty bullet above the reference. the lab photograph
was not retained. try both the initial seed and a new item made with enter.

`apps/web/src/lib/notes/outlineController.ts` inserts a sibling after a
non-reference row (`insertReference`, lines 2363–2370); only a seed/root uses
the head path. one unconfirmed explanation is that typing `@` converts the seed
to a pending note before acceptance, so the seed-consumption branch is missed.
this mechanism has not been established.

impact: reference entry can leave an unintended empty bullet. `docs/modules/notes.md`
already requires seed acceptance to create its direct relationship, but does
not settle acceptance from an empty non-seed item; deliberate empty notes must
remain possible.

resolved when: the seed contract holds and the owner decides and documents the
non-seed behavior, then verifies that acceptance leaves neither accidental
blank items nor silently discarded deliberate writing.
