# browser session recovery

## purpose and owners

remote credentials and a confirmed local account have separate lifetimes.
expiry may stop remote requests; it does not evict the workspace or its local
writing. `lib/native/admission.ts` owns remote admission, `lib/authored` owns
local account admission and sign-in, and `lib/auth/UnauthenticatedApiBoundary.tsx`
owns the remaining browser redirect boundary.

server auth redirects use `APP_PUBLIC_URL` through `lib/auth/session.ts`.
`next.config.ts` disables middleware url normalization so next preserves that
canonical origin, including numeric loopback hosts. workspace GET/HEAD routes
rewrite to the asset shell before credential redirects. `BrowserWorkspace`
opens a confirmed local binding without credentials; first provisioning still
requires verified server data.

## a workspace survives expiry

`apiFetch` observes a failure against the account that sent its request. a
retired response cannot change another account's admission. a current browser
401 requests sign-in; a 403 does so only for `E_ACCOUNT_MISMATCH`. other 403s
remain their own refusals. a native 401 starts the host's session check.
`checkSession` has no browser implementation: only the native bridge can answer
it. an installed unsafe-method request waits for that check, bounded by its
own deadline or thirty seconds; this includes reads sent as POST.

`handleUnauthenticatedApiError` returns false in installed documents and in a
mounted workspace identified by its root. domain owners therefore settle the
failed request and retain their local state. account conditions and object
failures present the canonical sign-in remedy; no failure-triggered document
navigation replaces the workspace.

`AuthoredProvider` owns deliberate sign-in. a browser uses the login path with
its validated return target; ordinary work guards still protect departure.
the installed host performs `sessionSignIn`, exposes its pending state, and
reports a different account or failed attempt without changing local ownership.
remote read repair can wake when admission recovers; writes resume only after
a deliberate command. [api edge](api-edge.md) owns the shared failure partition.

## the remaining redirect boundary

`isUnauthenticatedApiError` recognizes only an `ApiError` with status 401 and
code `E_UNAUTHENTICATED`. plain objects, other codes and other statuses do not
qualify. outside the workspace and installed-document exclusions, the global
handler has one runtime latch. a recognized failure after navigation started
returns true. a non-browser call or current `/login` location returns false.
otherwise it marks security teardown and assigns the same-origin login path.

`parseReturnTarget` validates the current pathname and query, without a hash.
unsafe or auth destinations resolve to `/lectern`, which omits `next`. an assign
failure propagates, clears teardown and leaves the latch unset. a successful
assign sets the latch; the same runtime does not retry navigation.
`securityTeardownStarted` lets document-exit guards yield to this navigation;
it does not discard authored work.

`UnauthenticatedApiBoundary` supplies the handler and registers one
`unhandledrejection` listener for its mounted lifetime. it suppresses a rejection
when login navigation owns it, and also suppresses recognized native 401s whose
recovery belongs to the installed host. the context outside that boundary
returns false. public share capture therefore keeps its own sign-in guidance
and remains on its screen. explicit direct-handler callers still receive the
same workspace and installed-document exclusions.
