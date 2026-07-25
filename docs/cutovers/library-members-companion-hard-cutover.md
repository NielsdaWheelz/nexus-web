# Library Members Companion Hard Cutover

Status: IMPLEMENTED
Type: hard cutover
Date: 2026-07-24
Open questions: none
Validation: implemented and adversarially verified against current code,
architecture, modules, `docs/rules`, focused backend/frontend tests, and the
real-stack acceptance scenario below.

## Decision

Mutable libraries managed by the viewer publish a **Members** tab in the
existing Companion:

```text
Library
  primary: Entries
  Companion: Members | Connections | Dossier
  default: Dossier
```

Members is the sole library-governance UI. Library Share retains link actions
and, for an authorized admin, one **Manage members** action that opens the
Library pane directly on Members.

This is a destructive replacement. The Share-embedded editor, old component and
client names, duplicate Library decoder, compatibility exports, fallbacks, and
stale documentation are deleted.

## Validated Current State

The cutover is grounded in these checked-in facts:

- `components/sharing/ShareOverlay.tsx` directly renders
  `LibraryMemberEditor`; the editor owns load, search, command, confirmation,
  member, and invitation state locally, so closing/unmounting Share discards it.
- `LibraryMemberEditor.module.css` changes row layout with a viewport media
  query. A 280 px desktop Companion inside a wide viewport therefore retains the
  wide row layout. The existing secondary group itself is defined for 280–720 px.
- `lib/libraries/client.ts` and `lib/libraries/sharing.ts` duplicate Library
  decoding, while `lib/panes/paneResourceLoaders.ts` currently forwards the
  Library bootstrap payload without the same exact decoder.
- `lib/libraries/sharing.ts` and `lib/sharing/api.ts` duplicate user-search
  transport/decoding.
- Member-role PATCH returns a partial person projection in
  `services/library_governance.py`; both the changed and idempotent paths omit
  fields that the list projection includes.
- Member and invitation list services clamp each request to 200, but no storage
  or write invariant caps total rows. Treating 200 as total completeness would
  hide valid governance state.
- `LibraryPaneBody.tsx` already owns the route Library projection. Resource
  Inspector already supports optional domain bodies, capability-gated
  publication, responsive desktop/mobile hosts, and Dossier as the Library
  default.
- `library_governance` already derives `canManageMembers`; user-search and invite
  services already resolve existing Nexus users, and no outbound invitation
  email path exists.
- Current default/system read behavior is not uniform, even though management
  mutations and publication are forbidden. This cutover does not rewrite that
  unrelated read policy.

## Frozen Scope

- Admin-only management of members, pending invitations, roles, removal, and
  ownership transfer.
- Existing Nexus accounts only. Name and account-email input resolve an existing
  user; Nexus does not send invitation email.
- Non-default, non-system libraries only.
- Existing `admin | member` roles, endpoint identities, and database tables.
- Cursor-complete member and pending-invitation reads. The existing endpoints
  change from capped arrays to exact-decoded page envelopes; this is an
  intentional hard-cutover contract change, not a compatibility layer.
- Owned `Presence<T>` absence for the member, invitation, and user-search
  projections changed by this cutover. Unrelated Library projections are not
  opportunistically migrated here.
- Existing Resource Inspector, workspace secondary activation, responsive
  desktop/mobile hosts, people search, feedback, button, select, and action-menu
  primitives.

## Goals

- Put governance beside the governed Library, not inside generic Share.
- Preserve draft and loaded state while switching Companion tabs.
- Keep one isomorphic owner for Library decoding, one browser governance
  transport, one route-owned state controller, one presentation surface, and
  the existing backend policy/persistence owners.
- Make narrow 280–720 px Companion layouts first-class.
- Fix role mutation responses so every `LibraryMemberOut` is fully hydrated.
- Make the sole governance UI complete for every reachable member and pending
  invitation, including libraries with more than 200 rows.
- Reconcile every observed authority or command outcome against server truth
  without implying realtime revocation detection.

## Non-goals

- Self-leave, public member directory, new roles, groups, access requests, or
  per-entry permissions.
- Outbound email, account provisioning, invite links, or unregistered invitees.
- Virtualization, audit history, polling, push-based revocation, realtime
  updates, or notifications. Cursor pagination is required for correctness;
  rendering more than one page remains incremental.
- A new route, database table, migration, backend capability field, secondary
  group, modal, drawer, mobile host, or generic administration framework.
- Redesigning library entries, sharing grants, Dossiers, connections, or viewer
  invitation acceptance in the Libraries index.

## Rules

- Follow [`docs/rules`](../rules/index.md), especially
  [`cleanliness`](../rules/cleanliness.md),
  [`boundaries`](../rules/boundaries.md),
  [`control flow`](../rules/control-flow.md),
  [`concurrency`](../rules/concurrency.md),
  [`database`](../rules/database.md),
  [`frontend`](../rules/frontend.md), and
  [`testing`](../rules/testing.md).
- Server capabilities authorize; the browser never reconstructs policy.
- Same-system payloads are exact-decoded once. Malformed owned payloads defect.
  Every Library-by-ID boundary also requires the decoded `LibraryOut.id` to
  equal the requested Library ID before committing state or deriving a
  capability; a mismatch is the same contract defect, never absence.
- Expected API failures render actionable feedback. Aborts and superseded
  responses never overwrite current state.
- One exhaustive `libraryGovernanceErrorMessage` screen-boundary helper maps
  structured expected API errors. It never catches or reclassifies decoder
  defects.
- One command runs at a time. Mutations are never aborted. Every settled command
  reconciles authoritative Library governance state because a client-observed
  failure can follow a committed write.
- Database-only governance mutations use the repository's standard
  `retry_serializable` one-transaction mutation boundary. Every retry attempt
  opens and commits its own transaction and reloads all working state inside the
  attempt; no mutable working state crosses attempts. No correctness claim
  depends on ad hoc row-lock ordering.
- No optimistic membership, role, invitation, or ownership truth.
- No old name re-export, dual render path, permissive parser, or silent fallback.

## Target Behavior

| Library/viewer state                          | Companion                                                                      | Share                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Non-default, non-system admin                 | `Members · Connections · Dossier`                                              | `Manage members`                                      |
| Non-default, non-system ordinary member       | `Connections · Dossier`                                                        | “Members are managed by library admins.”              |
| Default or system Library                     | `Connections · Dossier`                                                        | Link actions only; no claim that admins can manage it |
| Authority loss observed while Members is open | Members is unpublished; workspace reconciles to Dossier                        | Action disappears on the next Library projection      |
| Viewer membership loss observed               | The standard masked Library-not-found state replaces the Library and Inspector | Share can no longer load the Library                  |

Members behavior:

- First activation and pane reactivation revalidate the Library first. Authorized
  instances then load the first members and pending-invitations pages.
- Leaving and returning to Members in the same Library visit preserves loaded
  rows, query, selection, invite role, feedback, and confirmation state.
- Changing Library identity resets all Members presentation state and aborts
  stale reads/search. A mutation already in flight completes against the
  captured Library identity but may not publish into the new route epoch.
- Members and Pending invitations each expose a section-local **Load more**
  action while their opaque next cursor is present. Rows already confirmed stay
  rendered during page loads and retryable page failures.
- Member pages preserve server `userId ASC` order. This intentionally replaces
  the current owner/role-first order so the complete traversal uses the existing
  immutable primary-key index without another pagination subsystem. Owner and
  role remain visible row facts; the client does not regroup loaded pages.
- Search begins after three trimmed characters and reuses
  `PeopleSearchCombobox`; its IDs are instance-unique.
- Copy says **Find an existing Nexus user by name or account email**.
- Search exposes instruction-before-threshold, searching, result count/no
  matches, and retryable failure as programmatically associated status.
- Invitation submission requires a selected search result. Changing the query
  clears selection; the command always sends `{ kind: "User", userHandle }`.
  The backend's existing email-invite request branch is not exposed by this UI.
  Success says **Invitation created. They’ll see it in Nexus when they next open
  Libraries; no email was sent.**
- A member row uses display name as the primary label when present, account email
  as secondary identity when present, and the sealed handle only when both are
  absent. Owner and role are separate, programmatically associated facts.
- Non-owner role changes use the existing controlled `Select`. Its value remains
  server-confirmed while busy; failure restores focus and announces that no
  confirmed change was applied.
- Row consequences use `ActionMenu`: Remove member; Transfer ownership only for
  the owner viewing an eligible target.
- Remove and Transfer command descriptors set `restoreFocusOnClose: false` and
  capture `ActionSelectDetail.triggerEl` as the confirmation's return-focus
  target. The menu must not schedule competing trigger restoration while the
  confirmation mounts.
- Remove and transfer require an inline `role="alertdialog"` confirmation.
  Transfer names the target and states that the prior owner remains an admin.
  Removal names the target and states that other access paths may remain.
- Exactly one confirmation is exposed at a time. Its explicit title is
  referenced by `aria-labelledby`, its consequence text by `aria-describedby`,
  and its Cancel/destructive controls have unambiguous labels that include the
  named person where the action would otherwise be unclear.
- Confirmation focuses Cancel after mount. Escape/cancel returns focus to the
  captured trigger when it is still connected; otherwise it uses the next row,
  previous row, or section heading fallback. Success uses the same row/heading
  fallback and announces the result.
- Pending invitations are a separate section showing the assigned role and a
  Revoke action.
- Pending-invitation emptiness, search emptiness, initial loading/failure,
  retryable page failure, command failure, and busy states are explicit. The
  owner invariant means an authorized member list is not modeled as normally
  empty. A failed refresh retains the last confirmed snapshot but labels any
  unresolved mutation outcome honestly.
- The layout uses a container query or equivalent component-width signal to
  stack at Companion widths; it does not depend on viewport media queries.

Share behavior:

1. The existing exact-decoded Share snapshot remains the owner of link actions
   and canonical subject. For `LibraryMembership`, its subject must decode as
   `library:{id}`; a scheme mismatch is a same-system defect.
2. The capability-only Library projection loads from that decoded id and must
   return the same `LibraryOut.id`. Only that correlated projection may derive
   `canManageMembers`; an ID mismatch is a same-system defect. Link actions
   remain available during capability loading or retryable failure.
3. An ordinary eligible member sees the admin explanation. Default/system
   libraries receive no management action and no false admin-management claim.
4. `canManageMembers=true` renders **Manage members**.
5. The pane href is the snapshot's exact-decoded `authenticatedHref`.
   `expectAuthenticatedShareHref` already proves that it uses the canonical app
   origin and that its `/libraries/{id}` path matches the Library subject.
   Share does not interpolate an unowned route string or misuse a BFF/API
   transport descriptor as a navigation owner.
6. Activation calls `requestOpenInAppPane(snapshot.authenticatedHref, {
secondaryActivation: { kind: "Surface", surfaceId: "resource-members" }
})`.
7. A `true` result means the sanitized pane request was accepted for
   dispatch—not that rendering completed—so Share closes. A `false` result keeps
   Share open and renders feedback. `onClose` is threaded to the Share panel
   that owns this action.

## Capability Contract

Do not add a `members` backend capability.

```text
scheme eligibility:
  RESOURCE_CAPABILITIES.library.sharing == LibraryMembership

instance authorization:
  LibraryOut.canManageMembers == true

publication:
  eligible scheme AND authorized instance AND members body supplied
    -> publish resource-members
  otherwise
    -> omit resource-members
```

`canManageMembers` remains derived by `library_governance`; it is false for
default libraries, system libraries, and ordinary members. Every query and
command reauthorizes server-side.

This is an observation contract, not a realtime guarantee. Revalidate on
Members activation, pane reactivation, every settled command, and every Library
projection returned through the route. When an observed projection changes
`canManageMembers` to false, adopt it into route state, abort dependent reads,
clear governance drafts/confirmations, unpublish Members, reconcile secondary
selection to Dossier, and announce the change. If `GET Library` returns the
standard masked 404 because the viewer lost membership, clear the route-owned
Library and render the existing not-found state; Dossier is not available for a
Library the viewer can no longer read.

Extend the Resource Inspector domain-body contract:

```ts
interface InspectorDomainBodies {
  contents?: ReactNode;
  members?: ReactNode;
  linkedItems?: ReactNode;
  forks?: ReactNode;
}
```

Supplying `members` for a scheme whose sharing capability is not
`LibraryMembership` is a defect. `Members` is optional runtime composition, not
a `defaultSurfaceOrder` role. Dossier remains the Library default.

The canonical Inspector registry has seven surfaces after cutover. Add:

```ts
{
  id: "resource-members",
  groupId: "resource-inspector",
  title: "Members",
  iconId: "users",
}
```

Add `users` to the exhaustive shared secondary-tab icon map and exercise the
same registry entry through desktop and mobile hosts.

Fixed publication order is:

```text
Contents -> Members -> LinkedItems -> Forks -> Dossier
```

## State Contract

`LibraryPaneBody` already owns the canonical route Library. It owns one
route-keyed governance controller above the conditionally mounted tab body and
passes the current Library plus an `adoptLibrary(next)` callback. The governance
controller never stores a second Library projection.

```text
snapshot =
  | Idle
  | Loading
  | Failed { feedback }
  | Ready {
      members: PageState<LibraryMember>
      pendingInvites: PageState<LibraryInvite>
      refreshFeedback: FeedbackContent | null
      reconciliation: Confirmed | Reconciling | Unconfirmed
    }

PageState<T> = {
  rows: T[]
  nextCursor: Presence<OpaqueCursor>
  pageLoad: Idle | Loading | Failed { feedback }
}

search =
  | Idle
  | Waiting
  | Loading { sequence }
  | Ready { sequence, results }
  | Failed { sequence, feedback }

command =
  | Idle
  | Running
      { kind: Invite, userHandle, role, routeEpoch }
      | { kind: Role, userHandle, fromRole, toRole, routeEpoch }
      | { kind: Remove, userHandle, routeEpoch }
      | { kind: Revoke, invitationHandle, routeEpoch }
      | { kind: Transfer, userHandle, routeEpoch }

draft = {
  query: string
  selectedUser: UserSearchResult | null
  inviteRole: admin | member
  confirmation: Confirmation | null
}
```

- The route controller, not the tab body, owns state; inactive tab bodies
  unmount by design.
- The body calls idempotent `ensureFresh()` on activation. Library validation
  precedes governance list reads; do not parallelize the initial capability read
  with admin-only endpoints.
- `getMemberLibrary` and `paneResourceLoaders.library` both exact-decode and
  correlate the returned `LibraryOut.id` with their requested ID before
  returning it. A mismatched projection never reaches `adoptLibrary`, Share
  capability derivation, bootstrap state, or a not-found branch.
- Request sequence, route epoch, and `AbortController` own GET/search race
  safety. Abort controllers never wrap POST, PATCH, or DELETE.
- Commands capture their Library identity and route epoch. A route change
  prevents their settlement from writing into the new route, but does not
  cancel the server operation.
- After every command settlement—success or expected failure—read the Library
  first and pass it directly to `adoptLibrary`. If authority remains, restart
  both paginations from page one and reload through at least the previously
  loaded extent; if authority is gone, apply the observation contract above and
  stop.
- A 403/404 from a governance read or command triggers the same Library-first
  classification rather than guessing whether the resource, membership, or
  capability changed.
- If the command result is ambiguous and authoritative reconciliation also
  fails, retain only the last confirmed snapshot, mark `Unconfirmed`, disable
  every governance mutation, keep reads available, offer **Retry
  reconciliation**, and explain that the outcome is not yet confirmed. Retry
  repeats authoritative reconciliation, never the ambiguous mutation. No
  mutation is re-enabled until reconciliation confirms authority and governance
  state. Never display a failed command as proof that no write committed.
- Within an unchanged result set, page merges reject duplicate stable handles or
  cursor cycles as defects and preserve server order. If a repeated handle has a
  different membership/invitation creation identity, discard that load series
  and restart authoritative pagination from page one rather than silently
  de-duplicating concurrent reincarnations. Keep the last confirmed page when
  loading the next page fails.
- Components receive typed state and semantic commands; they do not call
  transport functions.

## API And Data Contract

No endpoint, table, or migration is added. The two admin list endpoints change
shape in place because their current maximum-200 array contract cannot support a
sole, complete governance UI.

| Operation                  | Endpoint                                                                 | Result after cutover   |
| -------------------------- | ------------------------------------------------------------------------ | ---------------------- |
| Capability/current Library | `GET /api/libraries/{libraryId}`                                         | exact `LibraryOut`     |
| Members                    | `GET /api/libraries/{libraryId}/members?limit=…&cursor=…`                | exact page envelope    |
| Pending invitations        | `GET /api/libraries/{libraryId}/invites?status=pending&limit=…&cursor=…` | exact page envelope    |
| Search existing users      | `GET /api/users/search?q=…`                                              | exact user projections |
| Invite                     | `POST /api/libraries/{libraryId}/invites`                                | `LibraryInvitationOut` |
| Change role                | `PATCH /api/libraries/{libraryId}/members/{userHandle}`                  | `LibraryMemberOut`     |
| Remove                     | `DELETE /api/libraries/{libraryId}/members/{userHandle}`                 | `204`                  |
| Revoke                     | `DELETE /api/libraries/invites/{invitationHandle}`                       | `204`                  |
| Transfer                   | `POST /api/libraries/{libraryId}/transfer-ownership`                     | `LibraryOut`           |

The two endpoints use one owner-specific, exact-decoded
`LibraryGovernancePageInfo`:

```text
{
  data: T[],
  page: {
    nextCursor: Presence<LibraryGovernanceCursor>
  }
}
```

- `LibraryGovernancePageInfo` is used only by
  `GET /libraries/{libraryId}/members` and the Library-scoped
  `GET /libraries/{libraryId}/invites`. Do not reuse or mutate the existing
  `LibraryPageInfo`, whose nullable, `has_more`-bearing contract is shared by
  unrelated Library list and writable-destination consumers.
- Keep the existing default 100 / maximum 200 page size, but never treat the
  maximum as a total-result cap.
- Members use immutable keyset order `userId ASC`, which follows the existing
  `(libraryId, userId)` primary-key index; owner and role remain visible
  attributes, not mutable pagination keys. Invitations use the existing indexed
  `(libraryId, status, createdAt DESC, id DESC)` order.
- Cursors are opaque, versioned, and bound to viewer, Library, endpoint kind,
  and invitation status where applicable. Wrong-scope, stale-format, and
  malformed cursors fail cleanly with `400 E_INVALID_CURSOR`; they are never
  accepted as a first page.
- Cursor tie-breakers carry the existing sealed user/invitation handles and
  unseal at the service ingress; no raw private database ID is exposed in the
  wire cursor.
- Fetch `limit + 1`, emit a cursor from the final returned row only when another
  row exists, and derive completion solely from `nextCursor`.
- Stateless keyset pages guarantee stable order and exact-once traversal only
  while the result set is unchanged. They are not a cross-request database
  snapshot. External concurrent create/remove/re-add activity is observed by
  activation/reactivation or command reconciliation, each of which restarts
  from page one.

Required projection and absence corrections:

- Role PATCH returns the same complete `LibraryMemberOut` projection as the
  members list, including `email` and `displayName` for both changed and
  idempotent updates. The service joins/re-reads the user projection; the route
  does not patch missing fields.
- The member, invitation, and user-search DTOs changed by this cutover encode
  semantic absence at the service/API boundary: `email`, `displayName`,
  `inviteeEmail`, and `inviteeDisplayName` are `Presence<string>`, and
  `respondedAt` is `Presence<datetime>`. Query adapters convert nullable database
  rows immediately; the frontend exact decoder preserves `Presence` through its
  domain models. No decoder accepts both raw `null` and `Presence`.
- Every `LibraryInvitationOut` result path—create, admin/viewer list,
  accepted/idempotent accept, and declined/idempotent decline—joins or re-reads
  the invitee user projection. Delete the current missing-key `row.get(...)`
  fallback: an unprojected value must never be mislabeled `Absent`. Tests cover
  both genuinely absent and present email/display name values on every path.

Preserve existing invariants:

- membership uniqueness and `admin | member` roles;
- exactly one owner and a matching owner membership;
- owner cannot be removed or demoted;
- transfer target is an existing member; prior owner remains admin;
- default/system management mutations and Members publication are forbidden.
  Existing default/system read behavior outside this UI is not silently changed
  or mischaracterized by this cutover;
- pending invitation uniqueness, no self-invite, atomic accept, masked 404s,
  Dossier audience invalidation on removal, and the current `can_share` billing
  entitlement check on invitation creation.

Exactly these touched database-only commands are audited into
`retry_serializable`: `create_library_invite`, `accept_library_invite`,
`decline_library_invite`, `revoke_library_invite`,
`update_library_member_role`, `remove_library_member`, and
`transfer_library_ownership`. Every attempt opens its own transaction and
reloads its working state. No other command enters scope through this
concurrency rule. Public integration tests must linearize role update versus
removal, transfer versus removal/demotion, and invitation acceptance versus
revoke into a valid serial outcome. Test assertions stay at API/service
behavior; they do not bless a particular lock sequence.

## Intra-system Composition

```text
LibraryPaneBody
  -> useLibraryMembers (route-owned state)
  -> LibraryMembersSurface (presentation)
  -> libraries/governance (browser transport)
  -> libraries/contract (isomorphic exact decoders)
  -> /api/libraries/*
  -> library_governance + library_invitations
  -> memberships + library_invitations

ShareOverlay
  -> sharing/api.fetchShareSnapshot (link actions + canonical subject)
  -> libraries/client.getMemberLibrary (correlated instance capability)
  -> libraries/contract
  -> sharing/wireValidation.expectAuthenticatedShareHref (canonical pane href)
  -> requestOpenInAppPane(resource-members)
  -> workspace pane graph
  -> the same LibraryPaneBody controller and surface

paneResourceLoaders.library
  -> libraries/contract (exact decode + requested-ID correlation)
  -> route-owned Library projection
```

`apps/web/src/lib/libraries/contract.ts` is pure/isomorphic and is the sole
`LibraryOut` plus governance-page decoder. Both browser `client.ts` and
isomorphic `paneResourceLoaders.ts` call it; a `"use client"` module cannot own
the server-bootstrap decoder. The contract exposes one
`expectLibraryOutForId(raw, requestedId)` composition that exact-decodes and
then defects unless the IDs match; singleton browser/bootstrap reads and
Library-returning mutations use it, while list results use the same underlying
`LibraryOut` decoder per row.
`apps/web/src/lib/libraries/governance.ts` is the sole browser
membership/invitation transport boundary.
`apps/web/src/lib/users/search.ts` is the sole user-search query and result
decoder used by Share and Members. Backend services remain the sole policy and
persistence owners.

Move `PeopleSearchCombobox` from the Share domain to
`components/users/PeopleSearchCombobox`. It owns a React `useId()`-derived input,
listbox, description, and status identity so every instance is collision-free;
callers do not supply a global ID. Preserve its existing keyboard model and
expose selection/query events without embedding Share or Library policy.

## File Plan

Add/move:

- `apps/web/src/components/libraries/LibraryMembersSurface.tsx`
- `apps/web/src/components/libraries/LibraryMembersSurface.module.css`
- `apps/web/src/components/libraries/LibraryMembersSurface.test.tsx`
- `apps/web/src/components/users/PeopleSearchCombobox.tsx`
- `apps/web/src/components/users/PeopleSearchCombobox.module.css`
- `apps/web/src/components/users/PeopleSearchCombobox.test.tsx`
- `apps/web/src/lib/libraries/contract.ts`
- `apps/web/src/lib/libraries/contract.test.ts`
- `apps/web/src/lib/libraries/governance.ts`
- `apps/web/src/lib/libraries/governanceState.ts`
- `apps/web/src/lib/libraries/governanceState.test.ts`
- `apps/web/src/lib/libraries/useLibraryMembers.ts`
- `apps/web/src/lib/users/search.ts`
- `apps/web/src/lib/users/search.test.ts` for pure decoding only
- `e2e/seed-library-members-companion.py`

Modify:

- `apps/web/src/app/(authenticated)/libraries/LibrariesPaneBody.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
- `apps/web/src/components/resource-inspector/inspectorSurfaces.ts`
- `apps/web/src/lib/dossiers/useResourceInspector.ts`
- `apps/web/src/lib/panes/paneSecondaryModel.ts`
- `apps/web/src/components/workspace/SecondarySurfaceTabs.tsx`
- `apps/web/src/components/sharing/ShareOverlay.tsx`
- `apps/web/src/lib/libraries/client.ts`
- `apps/web/src/lib/libraries/client.contract.test.ts`
- `apps/web/src/lib/sharing/api.ts`
- `apps/web/src/lib/sharing/api.test.ts`
- `apps/web/src/lib/panes/paneResourceLoaders.ts`
- `apps/web/src/lib/panes/paneResourceLoaders.test.ts`
- `apps/web/src/lib/panes/paneSecondaryModel.test.ts`
- `apps/web/src/lib/workspace/bootstrap.server.test.ts`
- `apps/web/src/components/resource-inspector/inspectorSurfaces.requiredBodies.test.ts`
- `apps/web/src/lib/dossiers/useResourceInspector.activation.test.tsx`
- `apps/web/src/components/workspace/SecondarySurfaceTabs.test.tsx`
- `apps/web/src/components/workspace/WorkspaceHost.test.tsx`
- `apps/web/src/components/sharing/ShareOverlay.test.tsx`
- `apps/web/src/app/(authenticated)/libraries/LibrariesPaneBody.ac4.test.tsx`
- `apps/web/src/app/(authenticated)/libraries/LibrariesPaneBody.systemLibrary.test.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.ac4.test.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.default.test.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.readingSlate.test.tsx`
- focused Library client and workspace-bootstrap tests
- `python/nexus/api/routes/libraries.py`
- `python/nexus/schemas/library.py`
- `python/nexus/schemas/user.py`
- `python/nexus/services/library_governance.py`
- `python/nexus/services/library_invitations.py`
- `python/nexus/services/users.py`
- focused projection, pagination, authorization, entitlement, and concurrency
  cases in `python/tests/test_libraries.py`
- user-search Presence plus member/invitation projection/page-envelope cases in
  `python/tests/test_user_profiles.py`
- Library-members hard-cut residue gates in
  `python/tests/test_cutover_negative_gates.py`
- `e2e/tests/library-members-companion.spec.ts`
- Presence migration in `e2e/tests/universal-resource-sharing.spec.ts`
- `resource-members` fixture typing in `e2e/tests/workspace.ts`
- `docs/architecture.md`
- `docs/modules/library.md`
- `docs/cutovers/resource-inspector-and-universal-dossiers-hard-cutover.md`
- `docs/cutovers/universal-resource-sharing-hard-cutover.md`
- `docs/cutovers/library-placement-resource-action-hard-cutover.md`

Delete after moving behavior:

- `apps/web/src/components/sharing/LibraryMemberEditor.tsx`
- `apps/web/src/components/sharing/LibraryMemberEditor.module.css`
- `apps/web/src/components/sharing/LibraryMemberEditor.test.tsx`
- `apps/web/src/components/sharing/PeopleSearchCombobox.tsx`
- `apps/web/src/components/sharing/PeopleSearchCombobox.module.css`
- `apps/web/src/components/sharing/PeopleSearchCombobox.test.tsx`
- `apps/web/src/lib/libraries/sharing.ts`
- `apps/web/src/lib/libraries/sharing.test.ts`

No compatibility file or re-export remains at an old path.

## Implementation Order

1. Write failing public backend pagination/projection/concurrency tests, pure
   decoder/state tests, browser component tests, and real-stack acceptance paths.
2. Introduce the pure isomorphic Library contract; route browser and
   server-bootstrap consumers through it. Hard-rename sharing transport to
   governance; centralize user search and update all consumers.
3. Change members/invites to cursor page envelopes; migrate the touched person
   absence fields to `Presence`; correct the role PATCH projection; audit
   touched mutations into `retry_serializable`.
4. Move the generic people combobox, then extract the route-owned controller and
   Companion-width presentation surface from the editor.
5. Add the seventh registry surface and optional Members composition.
6. Publish Members from `LibraryPaneBody` only when authorized; implement
   authority-first activation and settlement reconciliation.
7. Replace Share embedding with capability-gated pane activation while retaining
   link behavior during Library-loading failures.
8. Delete legacy paths; update normative and superseded docs; run residue grep.
9. Run focused static, unit, browser, backend integration, and real-stack
   acceptance tests. Do not substitute a broad suite for the named behavioral
   evidence.

## Acceptance Criteria

- **AC1 — Composition:** An eligible admin sees
  `Members | Connections | Dossier`; Dossier remains default.
- **AC2 — Authorization:** Ordinary members, default libraries, and system
  libraries never publish Members or expose a management action.
- **AC3 — Share cutover:** Share contains no editor or governance mutation; its
  authorized action is derived only from a subject-correlated Library projection
  and opens the correct Library pane and Members tab on desktop and mobile.
- **AC4 — State:** Switching Companion tabs preserves draft and confirmed data;
  changing Library identity resets it; stale reads and mutation settlements
  cannot write across route epochs, and mutations are not client-aborted.
- **AC5 — Governance:** Invite, revoke, role change, remove, and transfer render
  server-confirmed results and actionable expected failures. Every settlement
  performs Library-first reconciliation and never equates transport failure with
  proof that the write did not commit.
- **AC6 — Identity:** A role change never degrades a displayed person from
  display name/email to sealed handle.
- **AC7 — Semantics:** Email input is described and tested as existing-account
  lookup; invite requires a selected user; no UI claims that email is sent.
- **AC8 — Layout/accessibility:** The surface works at 280, 360, and 720 px and
  in the mobile sheet; tabs, combobox, menus, confirmations, focus, status, and
  error announcements retain valid accessible semantics. Opening a destructive
  confirmation cannot race the menu's default trigger-focus restoration.
- **AC9 — Security/concurrency:** Server authorization, masked lookup, owner and
  invitation invariants, billing entitlement, serializable command outcomes,
  and visibility invalidation remain covered through public behavior.
- **AC10 — One path:** No `LibraryMemberEditor`, Share-owned governance,
  `lib/libraries/sharing`, old import, duplicate Library decoder/user-search
  client, stale six-surface assertion, or stale `Connections | Dossier` Library
  claim remains. Repository negative gates fail if any prohibited path returns.
- **AC11 — Completeness:** With an unchanged result set, more than 200 members
  are reachable exactly once in stable `userId ASC` order and more than 200
  pending invitations are reachable exactly once in their indexed order. Page
  retry preserves prior rows; invalid or wrong-scope cursors return
  `E_INVALID_CURSOR`. Reactivation/command reconciliation restarts from page one
  and observes concurrent changes without claiming cross-request snapshot
  isolation.
- **AC12 — Authority observation:** Activation, reactivation, command settlement,
  and returned Library projections remove stale governance when authority loss
  is observed. Viewer membership loss uses the standard not-found state. No test
  or copy promises idle realtime detection.
- **AC13 — Boundary ownership:** Browser fetches and server bootstrap use the one
  isomorphic exact Library decoder and one requested-ID correlation helper;
  mismatched singleton Library responses defect before state/capability use.
  Touched member/invitation/search absence has one `Presence` wire shape; local
  component emptiness uses explicit variants or `null`, not `Presence`.

## Verification

- Backend integration: focused `python/tests/test_libraries.py` member, invite,
  entitlement, transfer, hydrated-role, masked-authorization, cursor-scope,
  greater-than-200, present/absent invitation projection on every return path,
  page refresh after a concurrent write, and the three concurrent command-pair
  cases. Use the real test database and assert through public service/API
  behavior.
- Frontend unit: pure exact contract/page/Presence decoders, pure state
  transitions and stale-epoch decisions, seven-surface registry, and Members
  capability/order. Contract tests reject a valid `LibraryOut` whose ID differs
  from the requested singleton ID. No I/O or mocks.
- Frontend browser component: real combobox/menu/select/alertdialog interaction,
  280/360/720 container widths, page loading/retry, tab-state retention,
  server-confirmed role failure, and deterministic focus/live announcements.
  Assert the alertdialog's accessible name/description, one-dialog invariant,
  focus on open without menu-trigger focus theft, Escape/Cancel restoration,
  disconnected-trigger fallback, success focus relocation, and announcement.
  Do not mock internal modules.
- Workspace/transport integration: browser Library client,
  `paneResourceLoaders`, and `bootstrap.server` all exercise the one isomorphic
  decoder with valid, malformed, and valid-but-wrong-ID payloads. Share tests
  cover malformed/non-Library `LibraryMembership` subjects, mismatched
  capability projection IDs, canonical subject-bound `authenticatedHref`
  decoding, accepted dispatch, and rejected dispatch.
- Real-stack E2E: desktop and mobile Share-to-Members activation; admin versus
  ordinary/default/system users; selected-existing-user invitation; pagination
  beyond 200; and authority/membership loss observed on reactivation or command
  settlement. Use real services and multi-user sessions.
- Static: focused web lint/typecheck and repository formatting checks.
- Residue:

```text
LibraryMemberEditor
components/sharing/PeopleSearchCombobox
@/lib/libraries/sharing
searchLibraryUsers|searchShareUsers
library Share owns
exactly the six canonical surfaces
Library.*Connections \| Dossier
limit=200.*members|limit=200.*invites
LibraryMemberOut\[\]|LibraryInvitationOut\[\]
```

Also inspect direct `LibraryOut` structural decoders: only
`lib/libraries/contract.ts` may own one. Every residue match must be removed or
be an explicit historical supersession statement in this document.
