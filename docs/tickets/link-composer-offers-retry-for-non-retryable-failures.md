# the link composer offers Retry for failures a retry cannot fix

status: open · origin: 2026-10-10 visual primitives reauthor (cleanup/visual-primitives-reauthor), spec D1 remainder · area: web / resource graph

`lib/resourceGraph/useLinkComposer.ts:220-243` turns every create failure into a
`LinkComposerFailure` with a Retry (`Retry link` for a saved file) and, once the
picker is closed, a persistent notice keyed `resource-link:<client mutation id>`.
for `E_LINK_SELF`, `E_LINK_CAPABILITY`, `E_NOT_FOUND` and `E_INVALID_REQUEST`
(`CREATE_FAILURES`, `:21-35`) the copy itself says "Choose another target", yet
Retry resubmits the same request and fails identically. each failed link adds its
own key, so five failures fill the rail to its 48% cap (visual harness
J4.rail-is-capped-at-48pct-and-scrolls, which drives `E_LINK_CAPABILITY`).

since the rewrite every persistent notice has a dismiss (×), so the notice can
leave; the dead Retry remains.

what to do: classify create failures as retryable (transport, unknown outcome,
`E_LINK_TARGET_STALE`, idempotency replay) or final; a final one offers no Retry
and, after the picker closes, is a Danger hud rather than a persistent notice.

resolved when: closing the picker after an `E_LINK_CAPABILITY` failure shows no
Retry and leaves nothing in the rail, and a transport failure still persists
with a Retry that succeeds once healed.
