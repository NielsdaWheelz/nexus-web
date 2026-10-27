# native reference entry loses input focus

on `fb125c4bc`, mixed run `20261026-160223-d4f39f751434`/7790 cannot
select an offline note reference. the target exists locally. passive public
events show `@` entering the focused editor at 143–174 ms, host focusout at
196.8 ms, then every suffix key targeting `body` without input events. the
original option-count assertion fails; the query retains only `@`.

`LocalOutline.tsx:97–99` converts any native keyboard true→false edge into
`OutlineController.dismissKeyboard()` (`outlineController.ts:183`), which blurs
the current host. correlate that actual call before attributing the observed
focus loss; readiness is not a candidate (`useReferenceInput.isReady()` is true).

resolved when unchanged rapid native reference typing finds and accepts the
local target, including after navigation, without waits or a replacement input
queue. preserve block-selection commands, real back dismissal/reopen, keyboard
ownership and the two delivery-order graph assertions. no keyboard/platform
setting change or private corpus writer qualifies this behavior.

separate observed boundary: passive run `20261026-165039-66f5d0562841`/90055
shows the same connected `LEFT` field focused before real back, then `body`
focused immediately afterward while the caret still points into `LEFT`.
subsequent page-level keys cannot edit it. this matched the old documented
dismissal policy; it does not identify the earlier rapid-query blur caller.
the corrected policy separates keyboard/accessory presentation from input
ownership. require unchanged mixed input plus physical back/accessory/player
controls before closing this record.

`6b7a6b9bd` separates keyboard/accessory presentation from input ownership.
unchanged rapid reference entry and both graph delivery orders pass in installed
mixed run `20261026-172026-9f4262c30b44` on `89bbbbbef`. the original blur caller
remains unproved; the missing-input reproduction no longer fails. retain only
the affected physical back/accessory/player qualification before closing.
