# subscription recovery label violates lowercase floor

source: frozen `3643a20b466b135e17b5e5c196a00b030df872e2`.

problem and impact: subscription recovery label violates lowercase floor.

evidence: apps/web/src/lib/actions/usePodcastActions.ts:38 renders `Check subscription again` after facts.kind===Failed; onSelect=facts.retry reads action facts. spec content floor requires lowercase recovery copy.

counterexample: show a podcast action-facts read failure, then open its menu. current recovery row begins uppercase.

smallest truthful fix: change only the recovery label to `check subscription again`; callback stays a read.

resolved when: the frozen source row and resulting menu use lowercase.

verification: source only; no lab or native failure induced. root owns repository issue records and implementation.
