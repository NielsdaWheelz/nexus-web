# generation-effects list response is untyped

status: open · origin: 2026-10-09 web dead-code sweep (cleanup/web-dead-code, claude session) · area: settings / typed wire

`GET /generation-effects` (`python/nexus/api/routes/generation_effects.py:44-56`)
returns a bare `JSONResponse`, so `wire.gen.ts`
(`recent_generation_effects_generation_effects_get`) types its 200 body as
`unknown`. `SettingsAccountPaneBody.tsx:48-63` hand-declares
`GenerationEffect` / `GenerationEffectsPage` to read it.

no runtime defect is claimed; the browser copy of the shape can drift from the
server silently.

fix: declare a response model for the page (and the undo reply), regenerate the
wire, and replace the handwritten interfaces with `Schema<...>` / `ApiJson<...>`.

acceptance: the generated 200 body is typed and `SettingsAccountPaneBody.tsx`
declares no wire interface of its own; `./scripts/test` passes.
