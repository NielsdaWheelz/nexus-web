# release index reordering

status: pending canonical rollout
origin: 2026-10-16 approved index-reordering contract
area: collection order / migration / client pairing

migration `0291` follows `0290`. it creates the shared logged order-revision
sequence and initializes user lectern and library revisions; membership and
positions remain intact. the unpublished standalone branch called this `0287`;
that task fixture is retired. deploy only the canonical migration chain.

pair api, web, extension and android builds at wire revision `9`. conditional
membership writes and strict move responses require that cohort; the existing
426 gate refuses older clients. reload old tabs without discarding unresolved
move records. release through the existing controller with stopped writers,
verified backup and exact migration-head checks.

acceptance: canonical migration head `0291`, paired clients, and a normal
library/lectern move plus unconfirmed-move recovery succeed after rollout.
remove this issue when the canonical release owner records that acceptance.
