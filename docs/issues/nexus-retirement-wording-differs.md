# nexus: the retirement announcement differs between code and contract

found 2026-11-15 at `42618db32`; still differs at `6fc320a75`.
when an armed row leaves the list, `RETIRED` in
`apps/web/src/components/nexus/useNexusController.ts:77` announces
`that result is gone.`. `docs/modules/app-navigation.md:190` instead specifies
`selection no longer available`.

the mismatch invites a second product string. resolve when the module contract
and its owning constant name the same announcement.
