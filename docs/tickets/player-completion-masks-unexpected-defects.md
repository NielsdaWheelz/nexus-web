# player completion masks unexpected defects

status: open
origin: 2026-10-04, sol cleanup session; source review at 43e1fb44ceeb97e8ec43d2b7ea852d460452d0e3
area: browser player natural-end completion

`apps/web/src/lib/player/browserPlayerRuntime.tsx:1174–1185` and `:1241–1263` catch arbitrary failures and install ordinary paused-at-end after abort/auth/exact-item-not-found handling. `LecternProvider.tsx:372–380` explicitly rejects installation defects to its caller, so completion can swallow them. the same try also contains local transition work: a later exception after clearing completion identity is discarded by the catch's second identity check. `:1297–1301` launches this path without awaiting it. no unexpected defect reaches existing asyncDefect/render throw at :401/:2563. source-qualified only; no audio/runtime reproduction.

prerequisite: freeze stable exact/fallback mutation ids, same-id retry, current completion generation/token, canonical snapshot-before-advance, modeled abort/auth and exact E_NOT_FOUND downgrade behavior. separate operation rejection from accepted-result/local transition faults. report an admitted unexpected error through the existing observed browser defect port; retain stale-completion fencing. do not substitute an unobserved rejected void task or report partial effects as atomically undone.

acceptance: actual natural-end public runtime preserves exact completion/retry/fallback/current-state advance; an installation or local callback defect reaches the real render boundary instead of ordinary paused-at-end. already accepted durable effects remain accounted for, and retired completion cannot alter/fault a newer session. repair separately from the selected heartbeat rewrite.
