# a declined oauth consent's fragment rides the next return target

status: open · origin: 2026-10-20 python auth harness baseline (journey A-OAUTH.declined-fragment-not-inherited, XFAIL on main `4428634e8` and `f2025d935`) · area: web auth

supabase sends a provider error to `/auth/callback` in the query and again in
the fragment (`#error=access_denied&error_description=…&sb=`). the callback's
307 to `/login` (`apps/web/src/app/auth/callback/route.ts:27-34`) carries no
fragment, so the browser keeps supabase's, and `useReturnTarget`
(`apps/web/src/lib/auth/useReturnTarget.ts`) takes it for the viewer's
inherited fragment: the next password sign-in lands on
`/libraries#error=access_denied&…&sb=`. any provider refusal's fragment takes
the same path.

impact: low; a junk fragment on the landing url after a declined or refused
oauth attempt.

fix: the callback's redirects set an empty fragment (`#`) so the browser drops
the provider's, or `/login` ignores a fragment carrying supabase's `sb` marker.

resolved when A-OAUTH.declined-fragment-not-inherited passes: after a declined
github consent, a password sign-in lands on the plain target.
