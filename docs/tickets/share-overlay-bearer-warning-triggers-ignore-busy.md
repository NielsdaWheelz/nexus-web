# Share overlay's bearer-link warning triggers ignore the in-flight change

status: open · origin: 2026-09-28 resource-sharing reauthoring review (size/resource-sharing) · area: resource sharing / share overlay web

`apps/web/src/components/sharing/ShareOverlay.tsx` states "`busy` names the
change in flight and disables every other one" (L333), and every revocation
trigger passes `disabled={busy !== null}`. the "Share public link" (Native,
L535) and "Post to X" (L551) triggers do not. pressing one while a revoke or a
native share is in flight replaces the open confirmation with the bearer
warning; the in-flight change still completes and then clears or drops it.

impact: harmless today (the link section vanishes once its revoke lands), but
the overlay's one-change-at-a-time contract has two exceptions.

fix: pass `disabled={busy !== null}` to both `Small` triggers.

resolved when: with a revoke in flight, neither bearer-link trigger can be
pressed.
