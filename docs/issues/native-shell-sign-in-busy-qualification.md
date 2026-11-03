# native shell sign-in busy qualification

in-flow sign-in now reads the authored owner's busy state through `Shell.signInBusy`.
its installed pending path has not been exercised on a device: browser labs have no
`session_sign_in` bridge operation. `lib/native/client.ts:119` allows that operation
300 seconds; `lib/authored/provider.tsx:89-101` guards duplicate presses and owns busy.

qualify on an owned android lab: hold native sign-in pending after a failed read's
sign-in press, observe its busy control, press again, then settle. resolution means
one bridge operation, busy until settlement, and no duplicate failure report caused
by the busy flip. this does not block the statically checked binding or browser
refresh journeys; final device qualification owns the remaining observation.
