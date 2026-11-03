# retained import failures have no shared sign-in remedy

the accepted-source pane composes its sign-in-required failure through
`transportVerbs`, but the authenticated `FeedbackProvider` has no shell command,
so `ShellContext.signIn` is null. a confirmed local-root or installed workspace
retains its owners on a real 401; the pane can request sign-in without a verb.

evidence: `app/(authenticated)/AuthenticatedShell.tsx:80`,
`components/feedback/Feedback.tsx:159-168`, `components/feedback/stage.ts:70`,
`lib/auth/UnauthenticatedApiBoundary.tsx:25-28`, and the existing sign-in owner in
`lib/authored/provider.tsx:70-81,145`, relative to `apps/web/src`; base `1b63b570`,
review `cf83e053`.

feedback-homes integration `e47819e34` already binds that owner at
`AuthenticatedShell.tsx:80-86,91,123-126`, including its busy state. the import
branch is held until that cut lands; reuse this wiring when integrating it rather
than add a second shell producer. prove a real retained 401 shows and invokes
that remedy. actual native sign-in and unqualified auth fixtures remain explicit
limits.

real local-root chromium lab `20261102-235821-88c350e3bb9b` reproduced this:
public sign-out followed by the actual source GET returned 401; the same root,
time origin and pane survived with the correct failure and all-imports link,
but no sign-in button. the login action remained unreached. exact runtime
cleanup passed. the paired integration still owns the fix.

firefox independently reproduced the same actual401 and missing verb in
`20261103-000132-98d4d9f3ad6f`; its exact runtime cleanup also passed.
