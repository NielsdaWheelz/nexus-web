# a browser session check overwrites sign-in and update admission

status: open
origin: 2026-11-01 feedback-homes L0a repair
area: web / admission

`checkSession` has an owner only in the installed app. in a browser the native bridge is
absent, so `sessionCheck` rejects and its bound catch publishes `Unavailable`, from any
admission. the one browser caller is `try again` on a failed Nexus search, offered whenever
admission is not `Ready`.

under `SignInRequired` or `UpdateRequired` that press replaces the truth with a connection
story, and the next focus or `online` publishes `Ready`, so reads go out again for a session
that may still be lapsed. under `Unavailable` the press does nothing. rule 9.

impact: a sign-in or update condition can vanish on one press, until the next refused read
restores it. `UpdateRequired` is otherwise terminal for a document.

evidence: `apps/web/src/lib/native/client.ts:142`;
`apps/web/src/components/nexus/NexusRow.tsx:223`;
`apps/web/src/lib/native/admission.ts` `checkSession`. the lab case `a write admission refused
resumes once admission returns` drives this path in chromium and firefox.

reproduce: refuse a write with 403 `E_ACCOUNT_MISMATCH`, search in Nexus, press the recovery
control, press `try again`, dispatch `focus`.

resolved when: no browser press moves admission out of `SignInRequired` or `UpdateRequired`.
the Nexus failure takes its verb from the transport, and `checkSession` runs only where a
bridge can answer.
