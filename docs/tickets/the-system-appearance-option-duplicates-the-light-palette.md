# the system appearance option keeps a second copy of the light palette

status: open (decision needed) · origin: 2026-09-17 slop sweep (claude session)
· area: appearance · oi-148

`apps/web/src/app/globals.css` declares the light palette twice, verbatim: the
same 41 declarations (`--surface-canvas` through `--canvas-grain-image`) appear
at 202-241 under `[data-theme="light"]` and at 247-286 under `@media
(prefers-color-scheme: light) :root:not([data-theme])`. only the indentation
differs.

the second block exists solely for the system appearance option:
`lib/theme/cookie.ts` returns null when no `nx-theme` cookie is set,
`layout.tsx:153` then emits no `data-theme`, and
`SettingsAppearancePaneBody.tsx:42-45` offers `{ value: "system", name:
"System", hint: "Match your operating-system preference." }`. two things that
could refute this do not: the android offline bundle imports `globals.css` but
pins `<html data-theme="dark">` (`src/offline-reading/index.html:4`), so it
never takes the media route, and `lint:css-tokens` only requires each consumed
token to be declared somewhere, which the `[data-theme="light"]` block already
satisfies.

the only single-source alternative that keeps system is a render-blocking inline
script in `layout.tsx` that reads `matchMedia` before first paint and always
stamps a resolved `data-theme` — 45 css lines traded for a blocking script. so
this is a product decision, not a cleanup.

decision: keep the system appearance option, or default to dark and drop it?

prerequisite: the owner's answer.

fix: if system goes, delete `globals.css:244-288`, the `"system"` entries in
`SettingsAppearancePaneBody.tsx` (15, 20, 42-45, 61, 68, 149), the `AppTheme |
"system"` union in `lib/theme/setAppearanceAction.ts`, and make
`readThemeCookie` default to `"dark"`.

acceptance: the light palette has one declaration, or the duplicate is recorded
as the deliberate price of the system option.
