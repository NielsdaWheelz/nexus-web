# action menu disabled reasons are visually hidden

status: open
origin: 2026-10-14 menu design audit
area: web / shared action menu / feedback

`apps/web/src/components/ui/ActionMenu.tsx:261-269` connects disabled actions
to their explanation through `aria-describedby`, but `:316-319` renders the
explanation only in `sr-only` text. the ordinary item has no visible reason or
reason disclosure. a sighted user can see an unavailable action without being
able to discover what must change. this is source evidence; no universal
accessibility-conformance failure is claimed.

prerequisites: none. expose the existing reason as concise secondary text in
the opened action surface, retaining the accessible description. keep reasons
beside their commands; do not introduce a separate notification or duplicate
availability policy. allow longer text to wrap within the pane/viewport.

acceptance: an unavailable action explains why with pointer, keyboard and
touch, without requiring a screen reader. a long reason fits narrow layouts.
enabled actions stay compact and invocation remains blocked where required.
