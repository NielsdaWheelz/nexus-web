status: open
origin: 2026-09-14 pr #255 production qualification, source `634206213c50f9cdfcecfae8c8f7efc331ddec48`
area: release operator inputs / auth redirects

the preserved primary checkout's `deploy/env/env-prod-frontend:7` declares an
obsolete third `AUTH_ALLOWED_REDIRECT_ORIGINS` member:
`https://nexus-nutwfqa1h-niels-erik-nandals-projects.vercel.app`.
live vercel production configuration and supabase instead agree on exactly
`https://nexus.nielseriknandal.com` and `https://nexus-web-xi-two.vercel.app`
(supabase appends `/auth/callback`). syncing the stale local input would expand
the reviewed production redirect contract to an obsolete build url.

the initial owned auth verification using the local inputs failed. evidence:
`/tmp/nexus-release-255/auth-config-mismatch.json` records the differing declared
origins and live callbacks. `deploy/supabase/verify-auth-config.sh:355` requires
exact callback membership. after a read-only vercel production env pull to
`/tmp/nexus-release-255/vercel-production.env`, the existing verifier passed:

```sh
deploy/supabase/verify-auth-config.sh --env-file /tmp/nexus-release-255/vercel-production.env
```

`/tmp/nexus-release-255/auth-config-live-receipt.json` records source
`634206213c50f9cdfcecfae8c8f7efc331ddec48`, exit status 0, and
`2026-09-15T05:28:03.043454+00:00`. these are local qualification receipts;
the discrepancy and passing command are summarized here so their temporary
paths are not the sole evidence. the primary input was intentionally preserved.

prerequisite and fix: before any future environment sync, the operator must
review the live production contract and reconcile the unpublished local input
to its exact two origins. do not expand production to match the stale build url.

acceptance: the reconciled local input declares only the two reviewed origins;
the existing owned auth verifier passes using that input, with no production
redirect expansion. remove this ticket and its register entry when resolved.
