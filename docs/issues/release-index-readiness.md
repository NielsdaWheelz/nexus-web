# complete index activation

complete-index wire cutover is being implemented on `codex/index-readiness`.
selected finite endpoints remove cursors and limits; podcast and library indexes
return atomic aggregates. old clients cannot read the new representation.

the paired search release shipped wire 16 on 2026-10-25 at `3d81ef45ef28`
(schema 0317, android 0.3.8/code 29; `release-search.md`). this branch rebases
onto `a09557224` and advances the breaking index representation to wire 17.
recheck the release boundary before merge; later breaking changes before the
next release share this bump.

ship api/web and installed clients together under the existing release owner.
there is no data migration, compatibility path or automatic deployment here.
qualify installed catalog promotion, native consumption observations, trusted
android touch fling/find/selection/drag and actual screen-reader announcements
on the paired binaries. no attached android device or physical-input evidence
is available in this checkout. local chromium proof does not discharge these
checks. record measured large-index opening and sustained refresh costs with
the change's proof in the pr body.

resolve after exact wire/source pairing and these owner checks; retain any
failed performance or browser qualification as a separate issue.
