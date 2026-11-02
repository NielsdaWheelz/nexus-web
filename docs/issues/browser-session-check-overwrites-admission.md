# a browser session check overwrites sign-in and update admission

status: open
origin: 2026-11-01 feedback-homes L0a repair
area: web / admission

`checkSession` has an owner only in the installed app. in a browser the native bridge is
absent, so `sessionCheck` rejects and its bound catch publishes `Unavailable`, from any
admission. a browser reaches it two ways, both labelled `try again`:

- a failed Nexus search, offered whenever admission is not `Ready`.
- `this view needs a connection`, painted in place of any non-catalog pane entered while
  admission is not `Ready`. the reason is false under `SignInRequired` and `UpdateRequired`.
  rule 10.

under `SignInRequired` or `UpdateRequired` either press replaces the truth with a connection
story, and the next focus or `online` publishes `Ready`, so reads go out again for a session
that may still be lapsed. under `Unavailable` the press does nothing. rule 9.

impact: a sign-in or update condition can vanish on one press, until the next refused read
restores it. `UpdateRequired` is otherwise terminal for a document, and a worker 426 now sets
it, so a browser reaches this pane without any read of its own being refused.

evidence: `apps/web/src/lib/native/client.ts:142`;
`apps/web/src/components/nexus/NexusRow.tsx:223`;
`apps/web/src/components/workspace/WorkspaceHost.tsx:56,60`;
`apps/web/src/lib/native/admission.ts` `checkSession`. the lab case `a write admission refused
resumes once admission returns` drives the Nexus path in chromium and firefox. the pane path is
by reading, unrun.

reproduce: refuse a write with 403 `E_ACCOUNT_MISMATCH`, search in Nexus, press the recovery
control, press `try again`, dispatch `focus`. or, under `UpdateRequired`, open a non-catalog
pane and press `try again`.

resolved when: no browser press moves admission out of `SignInRequired` or `UpdateRequired`.
both sites take their reason and verb from the transport, and `checkSession` runs only where a
bridge can answer.
