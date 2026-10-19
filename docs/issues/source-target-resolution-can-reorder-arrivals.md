# older source-target resolution can displace a newer arrival

source baseline: `69c00182c8328f46cec893517971f87f03cdbf16`; still present at `origin/main` `ff57128842b470510446b3edca54922ebcace41e` on 2026-10-16. line numbers refer to the original baseline unless stated otherwise.

status: open
origin: 2026-10-16 resource-reference architecture audit
area: reader / source activation

problem: live source arrivals resolve asynchronously without cancellation or a
latest-request check. an older slow resolution can finish after a newer reveal
and start a fresh navigation to the old target; the navigator's own fence begins
too late to know which user activation was newer.

evidence: `apps/web/src/app/(authenticated)/media/[id]/hostedReader.ts:270-277`
awaits the resolution before invoking `reader.inspect` and applies the result
unconditionally. both pulse and hash paths call it at `:279-295` without an
abort signal. the reader-target resolver already accepts a signal at `:97-106`,
and the navigator only cancels its currently started request at
`apps/web/src/lib/documentReader/navigator.ts:91-113`. source-confirmed; no live
execution.

prerequisite: one arrival owner per destination reader, from target resolution
through positioning and decoration.

proposed fix: abort the preceding arrival when a new activation arrives; carry
that signal through resolution and inspection, and publish a decoration only
while the same activation still owns the reader.

acceptance: hold resolution for target a, activate b and let it finish, then
release a. the reader remains at b with b's decoration. leaving the destination
visit retires both pending resolution and late focus/decoration changes.
