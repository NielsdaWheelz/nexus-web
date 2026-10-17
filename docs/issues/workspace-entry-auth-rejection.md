# workspace entry does not recover from an api auth rejection

status: open · origin: 2026-10-16 resource-reference device verification · area: web auth

an existing browser session can pass the web session check but fail the api's
issuer check. opening the isolated app on actual android chrome with a localhost
session from another local stack produced `ApiError: Invalid token issuer`, then
“something went wrong in the workspace”, with no sign-in recovery. the original
cookie was preserved and restored after using the isolated fixture session.

`apps/web/src/lib/workspace/bootstrap.server.ts:31` requires the api account/profile/session
reads. `apps/web/src/app/(authenticated)/layout.tsx` rethrows their auth error into the workspace
error boundary. the browser recovery owner only runs after shell entry, so it
cannot handle this failure. the api correctly rejects the foreign issuer in
`python/nexus/auth/verifier.py:162`.

handle recognized `401 E_UNAUTHENTICATED` at server workspace entry through the
existing auth recovery owner, preserving the return target and avoiding a loop
where the rejected session is immediately accepted again. do not loosen issuer
verification. this is separate from the resource-reference cutover.

resolved when a session accepted by the web boundary but rejected by the api
reaches a usable sign-in flow, returns to its requested workspace after successful
sign-in, and unrelated api defects still reach the workspace error boundary.
