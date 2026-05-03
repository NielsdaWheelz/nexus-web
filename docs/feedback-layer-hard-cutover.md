# Feedback Layer Hard Cutover

## Role

This document is the target-state plan for replacing scattered frontend
notifications, toasts, warnings, errors, and status messages with one feedback
layer.

The implementation is a hard cutover. The final state keeps no legacy
notification API, no compatibility wrapper, no fallback renderer, and no
backward-compatible behavior for old call sites.

Backend error modeling remains owned by [docs/rules/errors.md](rules/errors.md)
and the API envelope remains owned by `python/nexus/responses.py`.

## Goals

- One semantic feedback model for user-visible frontend feedback.
- One severity vocabulary across toasts, inline notices, banners, pills, and
  activity history.
- One API-error presentation path based on `ApiError.status`,
  `ApiError.code`, and `ApiError.requestId`.
- Correct routing between field errors, inline notices, banners, toasts,
  progress surfaces, dialogs, and durable activity.
- Accessible live-region behavior by severity and urgency.
- Consistent visual treatment using shared feedback components and existing
  Nexus design tokens.
- Durable support details for API failures without putting raw operational
  metadata in primary copy.
- Explicit separation between expected, modelable failures and defects.

## Non-Goals

- Do not redesign the backend error envelope.
- Do not change FastAPI service error taxonomy except where a frontend
  migration exposes a real missing backend error code.
- Do not introduce a third-party toast library as the product feedback
  architecture.
- Do not preserve `Toast`, `useToast`, or `StateMessage` as compatibility
  shims.
- Do not keep parallel severity names such as both `danger` and `error`.
- Do not use transient toasts for critical, blocking, form, or field-specific
  errors.
- Do not create a cross-session notification inbox in this cutover.
- Do not migrate unrelated logging or backend worker diagnostics into the
  frontend feedback layer.

## Final State

The app has one feedback capability with three public frontend entry points:

1. `useFeedback()` for emitted feedback events.
2. `FeedbackNotice` for explicit inline rendering in forms, panels, and panes.
3. `toFeedback()` for converting unknown caught values into typed feedback
   content.

All user-visible notification, toast, warning, error, empty, loading, and
success copy uses those entry points or lower-level renderers owned by the same
module.

Legacy files are deleted:

- `apps/web/src/components/Toast.tsx`
- `apps/web/src/components/Toast.module.css`
- `apps/web/src/components/ui/StateMessage.tsx`
- `apps/web/src/components/ui/StateMessage.module.css`

`StatusPill` survives only after its variant vocabulary is aligned to the
feedback severity vocabulary.

## Severity Vocabulary

Use exactly these severities:

- `neutral`: state with no risk or outcome judgment.
- `info`: useful context or non-critical status.
- `success`: completed user-initiated work.
- `warning`: recoverable risk, degraded behavior, conflict, or partial result.
- `error`: failed expected operation requiring user awareness or recovery.

`danger` is not a feedback severity. Destructive intent belongs to action
styling, not message severity.

## Feedback Data Model

All feedback content is structured data, not ad hoc strings.

```ts
type FeedbackSeverity = "neutral" | "info" | "success" | "warning" | "error";

type FeedbackSurface =
  | "field"
  | "inline"
  | "banner"
  | "toast"
  | "progress"
  | "dialog"
  | "activity";

type FeedbackScope = "field" | "section" | "pane" | "workspace" | "global";

type FeedbackPersistence =
  | "ephemeral"
  | "dismissible"
  | "sticky"
  | "durable";

interface FeedbackContent {
  severity: FeedbackSeverity;
  title: string;
  message?: string;
  requestId?: string;
  action?: FeedbackAction;
  secondaryAction?: FeedbackAction;
}

interface FeedbackEvent extends FeedbackContent {
  id?: string;
  surface?: FeedbackSurface;
  scope: FeedbackScope;
  scopeId?: string;
  persistence?: FeedbackPersistence;
  dedupeKey?: string;
  source?: "api" | "browser" | "reader" | "player" | "vault" | "chat" | "ingest";
}
```

APIs that construct feedback take object parameters.

## Routing Rules

Feedback routing is deterministic.

- Field validation renders as field feedback next to the owning input.
- Form submission errors render inline inside the form or panel.
- Blocking pane load failures render inline in the pane body.
- Empty states render inline and use `neutral` or `info`.
- Recoverable degraded behavior renders inline or as a pane banner.
- Workspace-wide service or account state renders as a workspace banner.
- Background sync, optimistic mutation, and non-blocking action results may
  render as toasts.
- Long-running uploads, imports, sync, transcription, and chat work render as
  progress feedback or domain-owned progress rows.
- Background work that may finish after the initiating UI changes is recorded
  in session activity.
- Destructive confirmations and blocking user decisions remain dialogs.
- Defects do not become normal feedback events. They go through error
  boundaries or generic failure UI and must be logged.

Call sites may request a surface only when the product requirement is explicit.
Otherwise the feedback layer selects the surface from `severity`, `scope`, and
`persistence`.

## Toast Rules

Toasts are only for non-blocking feedback.

- Toasts never carry field validation.
- Toasts never carry the only copy for a blocking error.
- Toasts never carry critical instructions that users must retain.
- Toasts with actions are sticky or mirrored into activity history.
- Error toasts are used only for local action failures where the surrounding UI
  remains usable.
- Toasts dedupe by `dedupeKey`.
- Repeated feedback updates an existing toast instead of stacking copies.
- At most five toast items are visible.
- Toast timers pause on hover, focus, and page invisibility.
- Toasts are keyboard reachable and dismissible.

## Inline Notice Rules

Inline notices are the default for feedback attached to a visible user task.

- Use inline notices for load failures, form errors, settings failures, scoped
  panel errors, reader warnings, empty states, and persistent success messages.
- Inline notices may include primary and secondary actions.
- Inline API errors may include a request-ID affordance.
- Inline notices do not self-dismiss.
- Inline notices use stable layout dimensions where needed to prevent pane
  jumps.

## Banner Rules

Banners are reserved for broad state.

- Use pane banners for state that affects the whole pane.
- Use workspace banners for account, auth, sync, billing, service degradation,
  or other workspace-wide state.
- Banners are dismissible only when dismissal does not hide an unresolved
  condition.
- Persistent unresolved conditions reappear after navigation.

## Activity Rules

Session activity is the durable surface for background feedback.

- Record long-running job outcomes, background sync failures, and completed
  background imports in activity.
- Activity records use the same `FeedbackContent` shape.
- Activity records retain request IDs.
- Activity records are session-durable in this cutover.
- Cross-session or backend-persisted notifications are outside this cutover.

## API Error Presentation

`apiFetch` remains the primary browser API helper.

The feedback layer owns API-error presentation through `toFeedback()`:

- `ApiError.code` drives known copy, severity, and default actions.
- `ApiError.status` is available for broad categories only when no specific
  code mapping exists.
- `ApiError.requestId` is rendered as support metadata for error feedback.
- Unknown API errors use the call-site fallback title and preserve request ID.
- Non-API errors use the call-site fallback unless the error is a whitelisted
  local browser API error whose message is safe and user-actionable.
- No component displays `ApiError.message` directly.
- No component appends request IDs by string concatenation.

Direct `fetch("/api/...")` calls are removed or replaced with typed helpers
that preserve the standard error envelope, including multipart/form-data
requests.

## Accessibility Rules

The feedback layer owns feedback accessibility semantics.

- `error` feedback that requires immediate awareness uses `role="alert"`.
- Non-error status feedback uses `role="status"` and polite live regions.
- Toast viewport live regions are present before feedback content changes.
- Live-region updates use `aria-atomic="true"` when replacing message content.
- Feedback never steals focus unless it opens a dialog or moves focus to a
  field with a validation error after submit.
- Field errors are associated with controls through `aria-describedby`.
- Toasts with controls are reachable by keyboard and do not disappear while
  focused.
- Dismiss buttons have specific accessible labels.

## Copy Rules

Feedback copy is product copy, not logs.

- Use user-actionable language.
- Use a concise title for the primary message.
- Use message text for recovery detail or context.
- Avoid exposing provider, stack, or storage details unless the user can act on
  them.
- Request IDs are secondary support metadata, not primary copy.
- Avoid generic "Failed to ..." as the only message when a better recovery
  instruction is available.
- Keep raw error messages out of UI unless they are safe API messages or
  whitelisted local browser errors.

## Architecture

Implemented files:

```text
apps/web/src/components/feedback/Feedback.tsx
apps/web/src/components/feedback/Feedback.module.css
apps/web/src/__tests__/components/Feedback.test.tsx
```

`FeedbackProvider` is mounted high enough to cover authenticated and
unauthenticated UI, including login.

The provider owns:

- Event IDs.
- Deduplication.
- Toast timers.
- Dismiss state.
- Live-region viewport state.

The conversion function owns:

- `unknown` to `FeedbackContent`.
- `ApiError` mapping.
- Request-ID formatting.

The renderers own:

- Markup.
- ARIA roles.
- Variant styling.
- Icons.
- Actions.
- Dismiss controls.

## Existing Files to Migrate

Shared primitives:

- `apps/web/src/components/Toast.tsx`
- `apps/web/src/components/ui/StateMessage.tsx`
- `apps/web/src/components/ui/StatusPill.tsx`
- `apps/web/src/components/ui/AppList.tsx`

Provider placement:

- `apps/web/src/app/layout.tsx`
- `apps/web/src/app/(authenticated)/layout.tsx`

API and conversion:

- `apps/web/src/lib/api/client.ts`
- `apps/web/src/lib/api/streamToken.ts`
- `apps/web/src/lib/media/ingestionClient.ts`
- `apps/web/src/components/AddContentTray.tsx`

High-volume user feedback surfaces:

- `apps/web/src/app/login/LoginPageClient.tsx`
- `apps/web/src/app/(authenticated)/search/SearchPaneBody.tsx`
- `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.tsx`
- `apps/web/src/app/(authenticated)/libraries/LibrariesPaneBody.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
- `apps/web/src/app/(authenticated)/conversations/ConversationsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/conversations/[id]/ConversationPaneBody.tsx`
- `apps/web/src/app/(authenticated)/settings/billing/SettingsBillingPaneBody.tsx`
- `apps/web/src/app/(authenticated)/settings/identities/SettingsIdentitiesPaneBody.tsx`
- `apps/web/src/app/(authenticated)/settings/keys/SettingsKeysPaneBody.tsx`
- `apps/web/src/app/(authenticated)/settings/local-vault/SettingsLocalVaultPaneBody.tsx`
- `apps/web/src/app/(authenticated)/settings/reader/SettingsReaderPaneBody.tsx`
- `apps/web/src/components/ChatComposer.tsx`
- `apps/web/src/components/LibraryMembershipPanel.tsx`
- `apps/web/src/components/LinkedItemsPane.tsx`
- `apps/web/src/components/PdfReader.tsx`
- `apps/web/src/components/chat/MessageRow.tsx`
- `apps/web/src/components/chat/QuoteChatSheet.tsx`

Tests:

- Add focused tests for feedback conversion, provider behavior, toast timing,
  accessibility roles, dedupe, request-ID display, and inline rendering.
- Update consumer tests to assert feedback through roles and visible copy.

## Cutover Plan

### 1. Add the new feedback layer

- Add shared types in the feedback module.
- Add `toFeedback()`.
- Add API error mapping.
- Add provider and renderers.
- Add focused tests for the new layer.

No existing call site is migrated in a partial PR unless the legacy components
are deleted in the same PR.

### 2. Normalize API error sources

- Keep `apiFetch` as the primary helper.
- Add a typed multipart/form helper so OPML preserves API envelopes.
- Update stream-token and SSE helpers to return structured errors where they
  cross into user feedback.
- Remove direct `fetch("/api/...")` call sites that manually parse error bodies.

### 3. Replace shared primitives

- Replace `ToastProvider` with `FeedbackProvider`.
- Replace `useToast()` call sites with `useFeedback()`.
- Replace `StateMessage` with `FeedbackNotice`.
- Align `StatusPill` and `AppListItem.status` variants.
- Delete old component files.

### 4. Migrate product surfaces

Migrate by product area, but keep the branch unmerged until every area is on the
new layer:

- Login/auth.
- Search and browse.
- Libraries.
- Media reader and highlights.
- Podcasts.
- Conversations and chat.
- Settings.
- Local vault.
- Player.
- Add content and uploads.

### 5. Remove legacy patterns

Remove every user-visible string catch pattern that bypasses feedback
conversion.

Required zero-result checks:

```sh
rg "components/Toast|useToast|StateMessage" apps/web/src
rg "variant=\"danger\"|variant: \"danger\"" apps/web/src
rg "isApiError\\([^)]*\\) \\? [^:]*\\.message" apps/web/src
rg "request id:|request ID:|request_id" apps/web/src/app apps/web/src/components
```

The final `request_id` matches may remain only in API tests, API client code,
and feedback-owned request-ID rendering.

### 6. Document the final rule

After implementation, move stable rules from this plan into a narrow rule owner
document such as `docs/rules/feedback.md`, then link it from
`docs/rules/index.md`.

## Acceptance Criteria

- All user-visible frontend feedback uses the new feedback layer.
- `Toast`, `useToast`, and `StateMessage` are deleted.
- No compatibility wrapper exports old names.
- No component displays `ApiError.message` directly.
- No component manually formats request IDs.
- No direct API `fetch` call loses the standard error envelope.
- Severity names are unified across toast, inline, banner, pill, and list
  status UI.
- Toasts are non-blocking only.
- Field errors render next to fields and are announced correctly.
- Blocking errors render inline or as banners, not only as toasts.
- Background action results render as toast and/or activity according to
  persistence.
- Request IDs are visible for API errors through a shared support affordance.
- Tests cover feedback conversion, rendering roles, dedupe, dismissal, timer
  behavior, request-ID display, and representative consumer flows.
- `make check`, `make test-front-unit`, and `make test-front-browser` pass.
- E2E coverage includes at least one real-stack API failure surfaced through
  the BFF and one user action failure surfaced through the feedback layer.

## Key Decisions

- Build a first-party feedback layer rather than adopt a toast framework.
- Treat toast as one surface, not the feedback architecture.
- Use semantic feedback data instead of string state.
- Keep API error envelopes unchanged.
- Centralize API error copy in the frontend feedback layer.
- Render request IDs as secondary support metadata.
- Mount feedback globally so login and authenticated app flows share behavior.
- Delete legacy primitives in the same cutover.
- Keep backend-persisted notifications out of this cutover.
- Promote durable rules to `docs/rules/feedback.md` only after the code lands.
