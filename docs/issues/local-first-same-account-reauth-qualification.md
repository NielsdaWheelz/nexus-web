# qualify same-account reauthentication

verification gap, not an established product failure. the startup contract in
`docs/local-first-writing-spec.md` requires same-account sign-in to resume
transport while retaining the confirmed local account.

`apps/web/.nexus-lab/cases/authored-lifecycle.spec.ts:80` proves expired
credentials leave local writing editable and durable across reload. it stops
before signing back in; the recorded green does not prove resumption.

resolve by extending that existing journey: retain the binding, replica and
pending command, sign in to the same account through the supported flow, then
prove the exact local writing reaches the server without purge, replacement
replica or a new semantic touch. qualify the installed host's corresponding
admission path during its pending native qualification.
