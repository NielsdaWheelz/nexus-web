# closing the Nexus withdraws the speculative read for the pane it just opened

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: speculative reads / nexus controller

## what is wrong

`apps/web/src/components/nexus/useNexusController.ts:427` runs `useEffect(() => {
if (!open) warmPane(null); })`, and `:592-604` closes the Nexus on an **accepted**
navigation. the close therefore withdraws the warm intent for the very pane the
navigation is opening: `paneWarm.ts:41` releases it and `resourceCache` aborts
and deletes the unclaimed pending entry, so the accepted navigation pays a cold
read it had already started warming.

the defect is in the trigger, not in `paneWarm`. `paneWarm`'s contract — a
warming surface has one current intent — is correct, and making it ignore a null
intent or delay withdrawal would be a lab hack that breaks oi-090's requirement
that an abandoned Nexus session release its speculation.

## prerequisites

distinguish the two ways a Nexus session ends: abandoned (withdraw) and accepted
(hand the intent to the pane that is opening).

## proposed fix

in `useNexusController`, withdraw on abandonment only; on an accepted navigation,
transfer the warm intent to the opening pane instead of releasing it.

## acceptance

accepting a Nexus result issues no second read for the resource that was already
warming; abandoning the Nexus still releases its speculation. observe the current
double read first.
