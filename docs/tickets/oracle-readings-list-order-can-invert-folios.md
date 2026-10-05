# the oracle readings list can order readings against their folio numbers

status: open · origin: 2026-10-04 cleanup campaign (claude coordinator), oracle slice · area: oracle

## what is wrong

the readings list sorts by `created_at`, which can tie or invert against folio order when two readings are created concurrently; the aleph then shows folios out of sequence. rare; not observed in a journey.

## fix

order by folio number (allocated per viewer under the creation lock), `created_at` as a tie-break.

## acceptance

two concurrent creates list in folio order.
