# a deliberate arm drops a waiting enter

status: open · origin: 2026-11-02 palette s3/s4 review · area: web / nexus controller (s2), `useNexusController.ts` `arm`

law 2 lets enter wait until `max(armedAt + 120, paintedAt + 200)` and then fire
the armed row once. `submit` parks that fire in `pendingFire`. `arm` (every
deliberate arming: arrows, pointer travel ≥8px, focus on a sheet row's control,
a row tap, the rail's `…`) starts with `clearTimeout(pendingFire.current)`, so
any of them inside the wait cancels the enter with no announcement.

impact: enter, then a resting hand drifting the pointer 8px over another row
within ~200ms, opens nothing. rare; silent.

evidence: by reading. `useNexusController.ts` `arm` clears the timer;
`submit` sets it; nothing else re-issues the enter.

why it is not just deleted: the clear also stops a double fire when the arm is
followed by an activation that keeps the palette open (a tap on `use this text…`
opens its page; the timer would then fire the armed row again). the fix needs a
call on what a waiting enter means after a deliberate selection.

fix (s2, owner's call): clear `pendingFire` in `activate` (any activation
supersedes a waiting enter) instead of in `arm`, so the waiting enter fires the
row armed when the window closes, which after `select` is the deliberate row;
or keep the clear and announce the cancellation.

resolved when: enter at 60ms after the last key, then 10px of pointer travel
within the wait, fires exactly one row.
