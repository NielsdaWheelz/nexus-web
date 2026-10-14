# session entry: implementation contract

status: implemented in `codex/session-entry-20261014`; isolated qualification
recorded below. coordinated production release and its smoke remain pending.
origin: 2026-10-14; reviewed head
`b6768bee2469cbc3a43902302836a44d07a11ea7` plus the working tree, captured as
`fb6c5b1bd7bdae63204fdd28a735524bb3d4c932`. initial tracked patch sha256:
`5c1a84af8c5cb656ac67074157e3c9dbc11c269f993d1e1dadf2b890ec523ea2`.
the snapshot includes prior working changes and is retained under
`proof/session-entry-20261014-isolated` (`83791a509`). the feature branch now replays
only its feature commits onto pinned main `f30a844a5`; review its delta against
that main revision. concurrent work advanced main; this campaign did not edit the
original checkout.

user decisions: usable active content takes precedence over earlier chrome;
retain mounted work through expected server-rerender failures; use an isolated
live stack for failure tests, then a non-destructive production smoke check.
this contract supersedes the earlier resolver-navigation proposal.
verification scope amendment, 2026-10-14: per user instruction, semantic checks
suffice; no voiceover or spoken screen-reader qualification is required.
auth, workspace/proof and design reviews challenged each handoff. the acceptance
contract remains normative; the qualification receipt records observed results.

## goal and boundary

opening nexus reaches the requested work without a session-restoration screen.
identity, workspace restoration and pane content retain distinct owners.

in scope: silent entry renewal, truthful terminal states, active-pane bootstrap,
strict saved-state reads, loading accessibility, auth return targets and the
android cutover. reuse the current rooms, fonts, asterism, controls and caches.

non-goals: new offline web capability, authentication providers, session storage,
cache framework, background refresh service, database migration, public branding,
seo campaigns, agent endpoints, unrelated pane redesign or permanent test suite.
private/auth surfaces remain uncached and unindexed where currently required.

## invariants

- `lib/supabase/auth.ts:refresh` remains the sole refresh-token spender. keep
  httpOnly cookies, chunk deletion, the 120-second margin and provider reuse rules.
- decoded cookies do not authorize data. protected rendering and the api retain
  verified authorization. no trusted viewer header or browser-held bearer.
- dependency unavailability preserves credentials; confirmed termination clears
  them. known rotation effects survive later rendering or operation failure.
- each entry request calls the refresh capability at most once. no success redirect, automatic
  browser retry, refresh timer, loop marker or compatibility route.
- account, reader profile and saved workspace must load before the store first mounts.
  malformed saved state is a defect; only a missing row means absence.
- expected failures have named outcomes. unknown exceptions and internal defects
  reach logged containment; they never become absence, optimistic data or retries.

## authentication composition

`page request → node middleware → read-only page verification → workspace bootstrap → active pane`

next 15.5.22 supports node middleware. set `config.runtime = "nodejs"`; retain
csp, nonce and existing path classification. middleware runs before rendering,
so renewal still delays first response. [framework contract](https://nextjs.org/docs/15/app/api-reference/file-conventions/middleware).

| capability | input → output | owner and authority |
|---|---|---|
| `readBearer` | cookie values → decoded bearer or null | envelope/type validation only; no expiry/margin decision or authorization |
| `getVerification` | explicit `readonly CookieValue[]` → `Verified {viewer, accessToken} \| MissingBearer \| Rejected` | verify present bearer without renewal margin; no writes |
| `resolveEntry` | explicit cookie values → existing `LiveSession` union | verify active credentials; refresh once when required; return successor jar/writes immediately |
| `verifySession` | request cookies/path → verified `Viewer` or terminal navigation/exception | retain server verification; never renew |
| `finish` / cookie-effect adapter | existing `Effect` → request-cookie view and/or response effects | one cookie-effect interpretation; response remains private/no-store |
| `liveSession` / `withActionSession` | existing contracts | bff/actions retain response ownership; action rerenders follow the gate below |

reuse `LiveSession`: `Live {accessToken, cookies, writes, cookieNames}`,
`Anonymous`, `Ended {cookieNames}`. `AuthUnavailable` and defects remain exceptions.
a refreshed result performs no further provider operation inside `resolveEntry`;
protected rendering or the extension backend verifies its bearer afterward.
the existing sdk may retry its exchange within the owned 5-second operation;
this is not an automatic browser retry or another refresh owner.
entry renewal applies `readSession`'s proactive margin in `resolveEntry`; existing
liveness operations retain it too. active verification
rejection refreshes once only if a refresh token exists. `callFastAPI` forwards
`readBearer` to the verifying api without reapplying that margin. a token crossing
120 seconds during the request must not become a false sign-out or defect.

middleware resolves protected `GET`/`HEAD` and `/login`, including actual rsc and
prefetch requests. exclude `/api/*`, `/auth/*`, extension start, static assets and
all other methods. never substitute html for an rsc response.
exclude bare `/auth` as well as `/auth/*` so the namespace 404 remains reachable.

| request/outcome | response behavior |
|---|---|
| protected / live | forward successor cookies and device identity; render original url; publish writes |
| protected / anonymous or ended | 303 to validated login target; clear only ended credentials |
| protected or login / unavailable | 303 to `/auth/session/unavailable?next=…`; preserve credentials |
| login / live | 303 to validated `next`; publish writes |
| login / anonymous or ended | render form; forward and publish any clear/ended-feedback effect |
| unexpected middleware exception | report and fail with platform/framework 500; no recovery redirect |

make `/login/page.tsx` passive: remove its verification/recovery redirects.
middleware overwrites `x-nexus-request-method` beside the existing request-path
header on every protected request; this metadata grants no identity. the page gate
always verifies. verified → viewer; `AuthUnavailable` → manual unavailable page;
GET/HEAD missing bearer → defect; GET/HEAD provider rejection → manual unavailable
(concurrent sign-out is possible); POST missing/rejected bearer → login. other or
missing method metadata defects. no gate renews. this handles cookie-writing action
rerenders, including `withActionSession` clearing ended cookies,
without a login/target loop. add root `app/error.tsx` for render defects above the
workspace boundary; it cannot style middleware exceptions.
construct auth redirects through the existing `APP_PUBLIC_URL` origin owner;
never trust an incoming host to select the destination origin.

apply the owned effect explicitly to request cookies, then create the forwarded
request and publish the same effect on its response. preserve unrelated cookies;
delete obsolete chunks; forward `nx_device` on the request that first creates it.
forward ended feedback on the same login request. use framework cookie APIs;
do not reinterpret response deletion cookies as ordinary values or hand-build
cookie headers. preserve downstream cookie effects and csp when composing responses.

`/extension/connect/start` validates redirect origin and state BEFORE resolution,
then calls `resolveEntry` itself: anonymous/ended →303 login with applicable clear;
unavailable →303 unavailable; live → existing token/error fragment. publish known
writes on success, expected failure
and caught/reportable 500 after extension-session creation fails. preserve its
existing external token/error fragment and correlation state. no second middleware
owner and no unguarded post-rotation throw that loses cookies.

### manual retry and return target

retain only the current `POST /auth/session/resolve` adapter:

| result | http / effect |
|---|---|
| live | 204; publish writes |
| anonymous / ended | 401; clear only ended credentials, with feedback |
| `AuthUnavailable` | 503; `Retry-After: 3`; preserve cookies |
| wrong origin or missing `X-Nexus-Session: Resolve` | 403; no credential operation |
| unexpected exception | logged 500; no modeled internal-failure outcome |

all responses are private/no-store. retain POST-only export: GET/HEAD are framework
405; OPTIONS is framework 204. `/auth/session/unavailable` performs no work on mount.
its button alone posts. 204 replaces with the target; 401 replaces with login;
503 remains actionable. fetch transport failure or a 12-second deadline means
unconfirmed, never signed out. cancel the owned request on unmount; prevent late
completion/navigation after timeout. retain the pending guard through navigation.
unknown responses/exceptions are thrown during render to the real error boundary.
the deadline cannot undo a provider rotation. losing that response may require
sign-in on a later attempt under provider reuse rules; do not promise lossless delivery.

`parseReturnTarget` remains the single local-target validator. remove framework
`_rsc` from canonical request/return paths without changing the forwarded rsc
request. successful renewal preserves the forwarded navigation's path, query and fragment.
existing pane url ownership can subsequently normalize equivalent query encoding;
entry does not take that ownership. server
redirects into login/unavailable omit fragments so navigation can inherit them;
redirects to a final target preserve its explicit hash. at login and
unavailable client ingress, complete validated `next` with the inherited hash only
when it lacks its own hash; reuse that target for retry, password submission and
provider/native links. resolve it before those actions can use an incomplete target;
keep browser-only hash handling out of server rendering. unsafe targets still use
`/lectern`. the marker proposal is deleted, not implemented.

`useReturnTarget(next: ReturnTarget): {kind: "Pending"} | {kind: "Ready";
target: ReturnTarget}` owns this client ingress. SSR/first hydration is Pending;
then complete and validate the current hash. while pending, render stable disabled
controls; provider controls have no actionable href. no spinner or new phase copy.
Ready supplies every action's target. no-js proof covers silent renewal; interactive
sign-in/retry requires javascript, as the current form submission does.

## workspace composition and schema

retain the generated `WorkspaceState` and existing `WorkspaceSessionsOut` wire
schema: `GET /me/workspace-session?device_id=…` returns `{data:{own,
most_recent_elsewhere}}`; each value is a valid state or null for a missing row.
PUT remains a validated state → 204. no schema copies, migrations or new persistence.
`WorkspaceBootstrap = {account: AuthenticatedAccount, readerProfile: ReaderProfile,
initialState: WorkspaceState, resources: DehydratedResources}` retains today's payload.

1. load account, reader profile and sessions concurrently with existing deadlines.
2. validate present stored state strictly. remove the validation-to-null catch;
   corruption raises the existing `500 E_INTERNAL`. preserve row and timestamp.
3. apply existing `enterWorkspace` selection/deep-link rules. select its guaranteed
   visible `activePrimaryPaneId`; do not add a second state validator.
4. run only that pane's registered loader with the existing 500 ms per-request
   prefetch budget. return zero/one successful `DehydratedResources` entry before
   first shell mount. retain loader keys and consume-once cache unchanged.

an unregistered active route has no seed. omit only explicit prefetch misses:
the transport codes below, `E_MEDIA_NOT_FOUND` for media, `E_LIBRARY_NOT_FOUND`
for libraries, and `E_INVALID_REQUEST` only for their external-id routes. the
existing pane owner then performs its normal read. all other errors propagate,
including 401, unknown codes and decoding defects. inactive panes fetch through
existing owners; no streamed-seed injection or new cache lifecycle.

classify required-read failures in the async `Workspace`, before react serializes
exceptions. export one transport predicate from `bootstrap.server.ts`, reused by
prefetch and rendering: `E_NETWORK`, `E_UPSTREAM`, `E_UPSTREAM_TIMEOUT`,
`E_AUTH_UNAVAILABLE` only. these get a local reload surface. other errors throw;
a post-verification bootstrap 401 must terminate, since redirecting to login could
loop with middleware's live-session continuation. mounted-api behavior stays intact.
cold failure mounts no store and cannot autosave a substitute.

`callFastAPI` owns fetch/response-stream transport normalization to `E_NETWORK`,
deadline to `E_UPSTREAM_TIMEOUT`, and malformed claimed json to
`E_INVALID_RESPONSE`. preserve request ids; unknown exceptions propagate. do not
classify arbitrary caller exceptions or status classes as network failures.
reuse `proxy.ts`'s exact gateway rule: non-json 502/503 → `E_UPSTREAM`, non-json
504 → `E_UPSTREAM_TIMEOUT`; malformed claimed json remains a defect.

### mounted continuity

cookie-writing actions can rerun the layout. async `Workspace` therefore passes
`EntryResult = {kind: "Ready"; bootstrap: WorkspaceBootstrap} | {kind: "Unavailable";
requestId?: string}` to a stable client `WorkspaceEntry`. key the enclosing
`AuthenticatedWorkspaceErrorBoundary` by verified `viewer.userId`, above suspense,
so a new viewer retires the prior subtree before required data finishes loading.
expose these existing-data types in `lib/workspace/bootstrap.ts`;
no persisted schema changes. only the exact transport predicate creates Unavailable.
unknown defects still throw.

`WorkspaceEntry({result, renderEnvironment})` captures the FIRST Ready payload as
its initializer. cold Unavailable shows the load-failure surface. after Ready,
always retain the same `AuthenticatedShell`, store, reader and resource-cache
instances; never reinstall later workspace/profile/seeds. pass fresh render
environment. later Unavailable publishes one existing persistent notice:
“workspace update wasn’t confirmed” / “your open workspace is still available.” /
“try again”. retry uses `router.refresh()` in one pending transition, not document
reload; repeated activation cannot start parallel retries. subsequent Ready clears
the notice without replacing content. clean up the notice on unmount.

pass `entryFailure: {requestId?: string} | null` to `AuthenticatedShell`. a small
private notice controller under its existing `WorkspaceStoreProvider` owns the
notice/retry. reuse `FeedbackAction.busy` for `aria-disabled`/`aria-busy` without
native disabling or changing the label. claim a synchronous guard, then
`startTransition(() => router.refresh())` (it returns void); release only when that
transition settles. the existing `Signal` owns removal focus and calls the notice's
`returnFocus` only while focus remains inside that notice. return the terminal
`entry-failure` element when present, otherwise the current pane landmark/chrome
through existing `paneDom` helpers. root/workspace defect boundaries expose this
same mutually exclusive DOM address. a ref updated after each committed pane
change keeps the destination current without republishing dismissed notices.
no event plumbing or second removal-focus owner; never steal moved focus.

viewer-key change discards the prior initializer/subtree before any failure can
display it. confirmed auth termination keeps the existing sign-in handoff. this
component retains initialization, not a second mutable workspace or data cache.
continuity covers required-data rereads after verification. identity-gate
unavailability can still leave the workspace for manual entry recovery; mounted bff
operation outages retain their existing local handling.

theme persistence needs no authenticated server operation. write `nx-theme` in its
existing browser appearance owner with path `/`, one-year max-age, lax, host-only,
and secure on https. keep synchronous html/meta painting and the server cookie
reader. delete `setAppearanceAction`, its import and async failure hud. introduce
no theme request or router refresh; rapid changes must leave the final selection.

## content and interaction contract

one entry designer owns auth copy; one workspace designer owns loading/return copy;
one native designer owns android terminal copy. each implements the rows below and
reviews the rendered result against its acceptance criterion. these are role-owned
copy schemas, not a content service or generic runtime state machine.

| feature / state | heading; body/status; action | content acceptance |
|---|---|---|
| routine renewal | no interface or announcement | no protocol vocabulary or success ceremony |
| unavailable page, initial | “nexus couldn’t open”; “try again to continue.”; “try again” | no unsupported diagnosis from a direct visit |
| retry: provider 503 | same heading; “sign-in is temporarily unavailable. try again in a moment.”; same button | never asks for new credentials during an outage |
| retry: unconfirmed | same heading; “nexus didn’t respond. check your connection and try again.”; same button | does not claim offline, failure or session termination as fact |
| retry: pending | retain explanation/button; adjacent “trying…” | one pending intent, stable focus and layout |
| ended session | existing form, heading “sign in to continue” | remove duplicate ended-session notice; keep real sign-in actions |
| verified workspace loading | existing static skeleton, accessible “opening your workspace…” | known geometry only; no fake titles, panes or progress |
| expected bootstrap failure | “your workspace couldn’t load”; “try again to open it.”; “try again” reloads | applies only before store mount; no invented save assurance |
| mounted bootstrap reread failure | “workspace update wasn’t confirmed”; “your open workspace is still available.”; “try again” refreshes server data | retain mounted state, focus and content; do not claim freshness |
| room selection | existing labels and immediate room/chrome painting; no save message | final selection persists; no auth or workspace interruption |
| root/workspace defect | “something went wrong” / “something went wrong in the workspace”; “nexus needs a fix before this can continue.”; no action | log original defect; no retry/reload recovery branch |
| pane loading | silent chunk skeleton; existing subject-specific data label, active pane only | no duplicate or inactive-pane live announcements |
| return to work | real content immediately; no completion message | preserve existing reader targets, mementos, scroll and focus owners |
| native redirect-loop defect | “something went wrong.”; “nexus couldn’t open this page.” | no retry; downloads only with actual shelf capability |

reuse `EntryCanvas`, `AsterismMark`, shared `Button` and room tokens. one small
`EntryFailure {title, description, children}` presentation serves unavailable and
root containment: decorative 32px mark, left-aligned 24rem column, existing text/
spacing tokens, safe-area scrolling. no card, duplicate wordmark, new font or asset.
login keeps `AuthSurface`. presentation owns no protocol, timer or reason enum.

keep the retry button and label mounted. use `aria-disabled`, `aria-busy` and a
synchronous guard; do not use `Button loading`, which natively disables it. one
persistent polite/atomic status beside the button begins empty, then announces
“trying…” or “couldn’t open.”; it never receives focus. retain pending through
successful navigation; release only after a modeled failed attempt. no countdown,
reveal delay, minimum dwell, entrance animation or automatic retry.

make `PaneLoadingState` bars static and remove its disposable `aria-busy`.
keep accessible text; a small private announcement child uses existing pane runtime/
active hooks only inside pane scope. outside it, honor the explicit caller choice.
make the lazy-module fallback silent; data loading owns the announcement. this
requires no pane-body edits or new provider. [aria busy semantics](https://www.w3.org/TR/wai-aria-1.2/#aria-busy).

match skeleton rail geometry to the live shell: collapsed width; mobile at ≤768px
or ≤900px with landscape/coarse pointer. retain all three room palettes, forced
colours and keyboard focus visibility. expected recovery owns its reload; defect
boundaries repair displaced focus once and never steal focus from surviving controls.

## hard cut and non-overlapping work packages

paths below are under `apps/web/src/` unless qualified. agree these contracts first;
then packages a–d can proceed independently. each file has one writer. the integrator
owns cross-package review, docs and proof, not competing application edits.

| package / owner | files | exact responsibility |
|---|---|---|
| a / auth engineer | `middleware.ts`; `lib/supabase/cookie.ts`; `lib/auth/session.ts`, `urls.ts`, new `useReturnTarget.ts`; `app/auth/session/resolve/route.ts`; `app/login/page.tsx`; `app/extension/connect/start/route.ts`; `app/robots.ts`; new `app/auth/[[...path]]/route.ts`; `lib/api/proxy.ts` | entry resolution, margin/validity separation, request/response effects, return-target ingress, passive login, extension publication/private response finalization, namespace retirement |
| b / entry and workspace designers + frontend engineer | new `components/EntryFailure.tsx` + css; new `app/auth/session/unavailable/{page.tsx,SessionUnavailable.tsx,SessionUnavailable.module.css}`; new `app/error.tsx`; `app/login/LoginPageClient.tsx`; `(authenticated)/layout.tsx`, `layout.module.css`, `AuthenticatedWorkspaceErrorBoundary.tsx`, `AuthenticatedShell.tsx`, new `WorkspaceEntry.tsx`, `settings/appearance/SettingsAppearancePaneBody.tsx`; `components/workspace/PaneLoadingState.*`; `components/feedback/Feedback.tsx`; `lib/panes/paneRenderRegistry.tsx`; delete `lib/theme/setAppearanceAction.ts` | content, retry/focus, retained initialization, local theme persistence, geometry/announcements; remove retired hydration-only state |
| c / workspace engineer | `lib/workspace/bootstrap.server.ts`, new `bootstrap.ts`, `model.ts`; `lib/api/server.ts`, `resourceTransport.ts`, `resourceTransport.server.ts`; `python/nexus/services/workspace_sessions.py` | active-only seed, strict reads, exact transport errors, bootstrap/result types, truthful comments |
| d / android engineer + native designer | `apps/android/app/src/main/java/app/nexus/android/MainActivity.kt` | remove recovery circuit; reuse hosted-load terminal for the two distinct native outcomes |
| e / independent verifier and integrator | temporary proof outside checkout; this plan, `docs/architecture.md`, `docs/modules/workspace.md`, `docs/modules/visual-system.md`, relevant tickets/register | adversarial oracles, receipts, final architecture, cutover/deletion audit |

package a deletes `app/auth/session/recover/` and `recoverPath`; removes its robots
entry and all callers. the new optional auth catch-all returns generic 404 for
unknown auth paths/methods, including bare `/auth`; exact routes retain priority.
export GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS at that namespace owner.
retired paths must never enter the authenticated root catch-all. no alias or shim.

package d deletes `RedirectLoopAction`, `RedirectLoopCircuit`, recovery-url building,
its dedicated overlay/state and call sites. a redirect loop stops loading, logs a
defect and shows the existing hosted-load terminal with defect copy and no retry.
ordinary connection failure retains its existing reload action. condition downloads
on `shelfRouter`; never clear webview data/cookies. ship web and android together.

leave cache/store schemas, pane loaders, persistence save scheduling, public-share
auth scope and mounted-app `401 E_UNAUTHENTICATED` handoff intact. remove obsolete
comments/contracts, the visible-pane seed map/aggregate await, loading pulse and
`AuthenticatedShell`'s unused `data-hydrated` state/effect/attribute.

## acceptance and temporary red → green → refactor proof

this task explicitly authorizes temporary live integration tests, overriding the
usual [verification rule](local-rules/testing-standards.md) for this campaign only.
`./scripts/test` remains the unchanged
static gate. no permanent harness, ci job, test dependency or production failpoint.

use production-mode next, real fastapi, isolated postgres and supabase auth. synthetic
`/libraries` active + `/conversations` inactive fixtures need no worker/model/object
store. create normal data through real boundaries; corrupt only the isolated saved
row for that case. temporary transparent proxies at existing upstream origins inject
selected faults and forward other traffic. browser interception can reject cookie
writes. no mocked internal modules or authentication bypass.

| proof | required observable result |
|---|---|
| active/refreshable entry: document, head, real rsc/prefetch, js disabled | no recovery document/post/success redirect; original destination; one refresh maximum per request |
| timing/action boundaries | real bearer crosses 120-second margin between preparation and render without false rejection; ended auth-action cookie clear terminates correctly; no login loop or lost cookie effects; offline/expired-session theme selection issues no request and final selection survives reload |
| cookie composition and concurrency | successor/chunk deletion/device identity correct; rotation survives downstream redirect/500 and extension failure; concurrent tab/api requests do not lose session; no assumed global single-flight |
| rejected browser cookies | response may use forwarded successor; next deliberate navigation resolves or signs in; no automatic loop |
| ended/outage/retry | distinguish 401/503/defect; preserve outage cookies; no mount attempt; keyboard retry keeps same node/focus; duplicate activation sends one request; deadline settles by 12 seconds without late navigation |
| lost rotation response | withhold final-hop response headers after real refresh; verify predecessor cookies remain; deadline causes no late navigation/automatic retry; later attempt may legitimately require sign-in |
| return targets and retirement | path/query/hash through success, outage and password/provider/native sign-in; unsafe target rejected; no `_rsc` in saved state; invalid extension input does not refresh; old/unknown auth URLs 404, resolver GET405 |
| independent content | server bootstrap requests only the active loader; successful seed prevents duplicate initial client read; actual active control works; unrelated 400 ms delay adds no bootstrap dependency |
| strict restoration | cold required failure causes no workspace PUT; malformed row returns `E_INTERNAL` and stays unchanged; absence still starts normally; valid restore/deep link preserves pane ids, widths, history and active selection; broken response stream is recoverable, malformed json/unknown codes/401 terminate |
| mounted rerender | edit a fixture; use real `loadLinkedIdentities` with refreshable credentials, or router refresh; fail a required reread; retain identical draft DOM node, selection, pane ids/store; retry clears notice with correct focus and no remount; viewer change discards prior workspace; existing autosave remains allowed |
| presentation/native | three rooms, collapsed rail, portrait, 850px coarse landscape, keyboard, semantic accessibility, forced colours; meaningful single announcement; physical android sign-in/renewal and loop/connection terminals |

baseline red must fail on behavior: visible restoration, unrelated server seed,
lost retry focus, unbounded request or overwritten invalid row. missing future
selectors/routes are not valid red evidence. holding an inactive request until after
content appears is insufficient: today's 500 ms seed timeout can already pass that.
record ttfb, shell appearance and active actionable content separately; no invented
latency sla. compare paired warm runs and inspect actual dependency/request counts.

sequence: snapshot base/diff → independent oracle review → observe red → implement
by owner → green → adversarial contract/content/cookie/data review → refactor →
repeat affected proof and static gate → review sanitized receipt → delete campaign.
review challenges every handoff: wrong cause, hidden fallback, stale response, lost
cookie, duplicate ownership, false copy and unmeasured performance claim.

keep runner, proxies, dependencies, credentials and raw artifacts under a unique
`/tmp/nexus-session-entry-*` directory. remove owned processes, ports, identities,
volumes, browser profiles and files after green/refactor. retain only source identity,
case results, timings, material limits and cleanup confirmation in this document.
run non-destructive production smoke after deployment; never inject outages there.
physical-device/deployment checks remain explicit pending evidence until performed.

## costs and release conditions

- node middleware adds server work before paint; read-only page verification may
  repeat provider work. this buys no success hop and avoids trusted-header machinery.
- a browser deadline bounds waiting, not provider execution; a lost rotation
  response can still require sign-in. retain the provider's reuse behavior.
- active seeding can still delay shell delivery; inactive panes lose server first
  paint. modeled prefetch misses use normal client reads; unexpected active-seed
  defects stop entry. no cache redesign or suppressed defects.
- strict invalid-state reads require explicit operator repair. no automatic reset.
  defect surfaces deliberately have no product retry. middleware defects retain the
  framework's visual 500; root react containment cannot change that boundary.
- mounted continuity adds one owner for the first successful initializer; later
  server reads do not replace live stores. only modeled data failures retain that
  work; identity-gate unavailability may still interrupt server refresh. theme
  persistence moves to its browser owner and loses its unnecessary async save path.
- auth controls wait for client hash completion. no-js renewal works; interactive
  sign-in/retry remains dependent on javascript.
- web/android cutover is coordinated; old android recovery URLs have no compatibility
  path. verify the current signed build and extension journey before release completes.
- isolation adds setup. deleting tests removes recurring regression protection;
  retained receipts document this change, not future correctness. production smoke
  does not prove production outage behavior.

resolve and delete only tickets actually proved fixed: routine session entry, retry
focus/deadline, optional pane seeds, skeleton breakpoint, invalid saved state, retired
hydration marker, busy loading status, inherited auth fragment, server transport,
prefetch defect suppression, workspace failure ownership, renewal-margin misuse
and mounted-rerender continuity. update the register.
keep unrelated findings, including pane-failure copy/ownership, in their tickets.
the [issue register](outstanding-issues.md) links their source evidence and acceptance.


## qualification receipt

initial application head: `e9741da69` (feature commits follow the captured baseline).
integrated application head: `8076f177dd7967e24e01c7c033255144dc67679c`, atop
`f30a844a5`. 15 affected cases passed after integration, including three added
notice-focus cases: terminal failure, moved focus, and current-pane dismissal.
56 distinct target cases passed in total; no baseline-only pass is counted.
the integrated production build and unchanged static gate passed.
shared `Feedback.tsx` is byte-identical to pinned main; its existing busy and
return-focus contracts replace the feature's earlier duplicated plumbing.
production-mode next 15.5.22, real fastapi, isolated postgres and supabase;
provider-issued es256 tokens with a real 130-second lifetime. the initial 53 target
cases passed across the campaign and affected reruns. no auth bypass,
forged token, internal mock, application failpoint or permanent test dependency.

baseline red observed visible restoration and an automatic resolver post, lost
keyboard focus, an unnecessary inactive server seed, overwritten invalid state,
unbounded browser retry and retryable internal defects. native red made two old
recovery requests and displayed restoration/retry after an actual redirect cycle.

| target group | observed green |
|---|---|
| entry and identity | document, HEAD, actual next-link rsc/prefetch, no-js renewal; no success hop/recovery post; genuine margin crossing remains authorized |
| effects and intent | chunk deletion, same-request device identity, outage preservation, downstream defect/extension failure rotation, concurrent tab/bff requests, ended action rerender; namespace/method and origin gates |
| bounded recovery | stable focused button; duplicate activation suppressed; real refresh response withheld beyond 12 s settles unconfirmed, preserves predecessor and never navigates late |
| target/content | password inherited/explicit/unsafe targets; outage query/hash; provider/native link targets; active-only server seed, consume-once seed, real actionable control and normal read after a seed deadline |
| strict data | cold failures produce no substitute PUT; corrupt row/timestamp remain intact with `E_INTERNAL`; broken streams recover; malformed json, unknown/internal codes, bootstrap 401 and active-seed defects terminate |
| continuity | actual identities action/refresh preserves draft node, selection and pane ids; repeated guarded notice retry/focus; terminal handoff, moved focus, and dismissal without revival; new viewer retires the old subtree during a held data read; valid deep link preserves widths/visits/history |
| presentation | three rooms visually reviewed, forced colours and keyboard ring; static skeleton at collapsed desktop, portrait and 850px coarse landscape; one active loading announcement, inactive loader silent; local room changes issue no operation even after genuine jwt expiry, and the final room survives renewal/reload |
| android/extension | six physical sm_s906w checks: password sign-in, silent renewal, two-path loop (with inherited fragment), persistent no-retry defect, real downloads/leave handoff, connection retry; cookies preserved. real extension bearer/state accepted by the extension bff |

adversarial repairs: viewer key moved above suspense after a live pending-interval
counterexample; url/headers are validated before `fetch(url, init)` so next cannot
discard the owned signal through its Request/init normalization; both extension
proxy exits use the existing private finalizer. postgres already forbids json
null: that proposed counterexample was rejected by the real constraint, so no
extra row-query machinery was added.

initial-source warm comparison: one warm-up plus four measured runs per source, identical real
libraries/chats fixture and 400 ms unrelated chats delay. medians, milliseconds:

| source | ttfb | visible pane strip | active control actionable |
|---|---:|---:|---:|
| captured baseline | 6.0 | 846.5 | 853.7 |
| candidate | 5.7 | 123.7 | 414.7 |

these include browser/driver and hydration overhead; they are local observations,
not an sla. separate no-js dependency proof counted one active/zero inactive
server reads; the baseline counted one/one.

limits: accessibility proves semantic/announcement structure. spoken output was
not tested, as requested. cookie refusal was reproduced by dropping auth
Set-Cookie fields at the final delivery proxy; the current response remained
usable and the next deliberate navigation resolved without a recovery loop.
next replaces document `vary` with its rsc fields; `private, no-store` survives.
the existing [variance ticket](tickets/auth-documents-lose-vary-cookie.md) remains.
production outage behavior was not injected or inferred.

integrated signed android candidate: package `app.nexus.android`, proposed 0.3.1/code 21;
release lint/build and signature verification passed. apk sha256:
`be715539977bbcef48f3b1058795cd41f9f29c40b5e004fa758a657b5668aa0e`.
signer sha256: `40e566dc0cde3b63ea8bf8f0779802938c0ba19d5c32d4810f28fdc546fd8b17`,
matching published 0.3.0/code 20. physical failure injection used identical
`MainActivity.kt` source in a separate debug app id; the installed personal app was not
replaced. installing the exact signed production apk, App Links/provider checks,
coordinated publication and production smoke are release gates under
[the runbook](../deployment.md) and [distribution rules](../README.md#android-release-distribution).

release evidence remains tracked in [the release ticket](tickets/session-entry-release-qualification.md).

cleanup confirmed: the temporary campaign directory, frozen worktree, test runners,
proxies, dependencies, credentials, raw logs/screenshots and owned browser profiles
were removed. owned next/api/proxy processes stopped; isolated auth/data containers,
volumes and networks were removed; synthetic identities were destroyed with them.
the device proof app and its adb forward/reverse were removed. all owned ports
were checked released. source worktree and normal signed build artifact remain.
no test harness, test-only production seam, dependency or ci job was retained.
