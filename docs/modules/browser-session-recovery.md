# browser session recovery

status: implemented, local browser proof and static gate passed · origin:
2026-10-02 cleanup campaign, base `56b889bdc` · area: web auth

## behavior and ownership

`lib/api/client.ts:isUnauthenticatedApiError` owns recognition: the value must
be an `ApiError`, its status must equal `401`, and its code must equal
`E_UNAUTHENTICATED`. a plain object, another status, or another code is not
recognized. `apiFetch` decodes failed structured responses into that class;
the session bff emits this exact status/code when the session has ended or is
absent (`lib/api/proxy.ts` `proxySession`, on `lib/auth/session.ts` `liveSession`).

`lib/auth/UnauthenticatedApiBoundary.tsx:handleUnauthenticatedApiError` owns
the one browser-runtime redirect latch. for an unrecognized error it returns
false, including after a redirect has started. for a recognized error it:

1. returns true immediately if this runtime already started login navigation;
2. otherwise, in a non-browser invocation or at a current `/login` location,
   returns false without navigation or changing the latch;
3. otherwise calls `window.location.assign` with the same-origin login path,
   sets the latch and returns true. it never resets the latch or retries a
   started navigation inside the same runtime.

the return target is the current pathname plus query, without the hash,
validated by `parseReturnTarget` in `lib/auth/urls.ts`. unsafe or auth
destinations resolve to `/lectern`; that default omits `next`. an assign
failure propagates and leaves the latch unset.

the authenticated shell mounts one `UnauthenticatedApiBoundary`
(`app/(authenticated)/AuthenticatedShell.tsx:69-84`). its context provides the
canonical handler directly. its effect registers one `unhandledrejection`
listener on mount and removes that exact listener on unmount. the listener
calls the same handler and prevents the rejection's default handling only
when it returns true. it has no second latch or handler policy. concurrent
request failures therefore start at most one navigation, and every later
recognized failure remains handled while this runtime survives.

the context hook is a present scope contract: outside the authenticated
boundary its default handler returns false. `app/share/page.tsx:10-13`
deliberately keeps the share capture outside the shell and login flow;
`ShareCapture.tsx` uses `useResource` for its account read there. a failed
share account read remains available to that screen's error handling and must
not navigate to login. inline auth guidance is owned and separately qualified by
[share capture recovery](share-capture-recovery.md).
explicit direct-handler callers retain their
existing decision to invoke global recovery. no alternate provider, scope
option, or compatibility api is added.

## verification receipt

2026-10-02: removed the boundary's second redirect ref and callback; the file
went from 75 to 60 lines. context, its seven consumers, and the shell mount
remain intact. a separate verifier ran the same reviewed production-bundle
chromium proof before and after, against real local bff auth rejections.
baseline passed 31/35 checks and failed repeated context handling
`[true,false,true,false]`, repeated mounted cancellation `[true,false]`, real
concurrent rejection cancellation `[true,false]`, and the escaped second
rejection. candidate passed 35/35 with all those recognized failures handled.

both runs observed exactly one login navigation with the correct pathname,
query return target and no hash. wrong status/code and nonauth errors remained
unhandled. unmount/remount prevention was `[false,true,false,true,false]`;
navigation count alone was not its oracle. fresh `/login` did not redirect;
a separate non-browser invocation returned false. outside-scope context calls
returned false, a real `useResource` account read retained its auth error with
no navigation, and anonymous `/share` retained sign-in guidance on `/share`.
the expired mounted `ShareCapture` rendering defect was outside this auth slice;
its later repair is qualified in the separate share capture recovery receipt.

tested source: base `56b889bdc6708d2d913982e22e7566a141b024d6` with only this
production source change. boundary sha256:
`a55456758cc49e0e0fa817a38df283dccc98e129a0216945f748b8ee083a7e9c`.
baseline boundary sha256:
`b74d5d06fc1023c9e08e0059562fe276f40be17067333b3cfc53ed41b7230890`.
the same browser oracle passed 35/35 again after integration onto main
`18232e20a44bcad899cb6326551fba4f68abefcd`, at source commit
`d427c8d20219f08b9d07597f98b1a2786d3d2c87`; the boundary hash above was
unchanged. the non-browser check and `./scripts/test` passed on that integrated
source, canonical migration head `0252`. production and physical device checks
were not run.

the temporary proof is removed after review; this spec retains the source
identity, observed outcomes, and limits. there is no maintained automatic
regression suite under the repository's
[verification contract](../local-rules/testing-standards.md).
