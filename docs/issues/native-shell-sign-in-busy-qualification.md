# native shell sign-in busy qualification

in-flow sign-in reads the authored owner's busy state through `Shell.signInBusy`.
`app/(authenticated)/AuthenticatedShell.tsx:77-83,121-122` publishes that binding;
`lib/authored/provider.tsx:85-102` owns the attempt and guards duplicate presses.
paths are under `apps/web/src`. the installed pending path remains unqualified:
browser labs have no real `session_sign_in` bridge operation. `lib/native/client.ts:119`
allows that operation 300 seconds. initial password handoff alone does not exercise
the shared shell's later sign-in remedy.

qualify on an owned android lab: hold native sign-in pending after a failed read's
sign-in press, observe its busy control, press again, then settle. resolution means
one bridge operation, busy until settlement, and no duplicate failure report caused
by the busy flip. this does not block the statically checked binding or browser
refresh journeys; final device qualification owns the remaining observation.
