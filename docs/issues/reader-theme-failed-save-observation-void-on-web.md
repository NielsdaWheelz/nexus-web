# reader theme failed-save observation is void on web

problem: whether a failed reader-profile save closes an open view menu cannot be
observed on web. the only permitted fault, browser offline mode, also flips web
`online` (`apps/web/src/lib/actions/ResourceActionsProvider.tsx:242`), and the item
section projects `!ctx.online` with no installed-app gate
(`lib/actions/project.tsx:732,958,1023`). the open menu therefore retires with
"actions changed" before the debounced PATCH fails. on main the command's own close
preceded the failure by 314ms (lab run `20261025-111419-6b573a53186d`).

impact: the interaction between the attention notice raised by a failed save and an
open, stay-open menu choice is unverified.

proposed fix: a fault path that fails only `PATCH /api/me/reader-profile` while
connectivity stays online and that the lab rules admit, or an admission-gated
item-section projection on web.

resolved when a lab case observes the menu's state across a failed save with
connectivity unchanged.
