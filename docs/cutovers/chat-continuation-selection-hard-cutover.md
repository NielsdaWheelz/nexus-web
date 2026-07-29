# Chat Continuation Selection Hard Cutover

**Status:** Implemented · 2026-07-28

**Posture:** One frontend cutover. No new persistence, API field, compatibility
path, profile mirror, feature flag, or silent fallback.

## 1. Decision

There are no blocking questions.

The next chat turn inherits the product profile and reasoning option of its
causal assistant parent. An explicit unsent draft choice wins. A new chat uses
the current product default.

This is derived next-turn state, not a conversation preference. `ChatRun`
remains the durable owner of historical selection and resolved execution facts.

## 2. Target behavior

| Situation | Final behavior |
|---|---|
| Send with Deep/High | The composer remains Deep/High after run creation, completion, pane remount, and reload. |
| Normal continuation | Inherit from the active-path assistant leaf's `ChatRun`. |
| Branch reply | Inherit from the exact assistant named by `BranchDraft.parentMessageId`. |
| Switch branch | Recompute from that branch's assistant source; never use another branch's newest run. |
| Explicit picker change | Apply to the current draft only; persist through existing draft storage; win over inheritance. |
| Successful send | Clear draft text/attempt/explicit choice; the new run becomes the inheritance source. |
| New conversation | Use `GET /llm-profiles.data.default_profile_id` and that profile's default reasoning option. |
| Historical selection is no longer offered | Use the current product default and render one quiet inline explanation. |
| Catalog is loading or failed | Preserve current loading/error behavior; do not invent a selection and do not send. |

## 3. Goals, scope, non-goals

### Goals

- preserve conversational profile/reasoning intent across send and reload;
- make inheritance causal and branch-correct;
- keep one next-turn resolver and one profile catalog owner;
- preserve provider-native cache affinity when the causal profile remains the
  same, without making cache behavior a UI contract;
- reduce state and effects.

### In scope

- frontend derivation from the already-loaded selected path;
- exact precedence and current-catalog validation;
- strict decoding of the draft's stored profile selection;
- controlled picker composition and unavailable-selection notice;
- completed-tree trust-trail parity required for strict cold rehydration;
- focused unit, browser, and real-stack E2E proof;
- deletion of the old effect-driven defaulting path and contradicted docs/tests.

Implementation follows `docs/rules/{boundaries,cleanliness,control-flow,frontend,
simplicity,testing}.md`: decode browser storage once, derive rather than mirror,
match finite variants exhaustively, and test observable behavior.

### Non-goals

- database migration or new conversation/profile-preference storage;
- new or changed FastAPI, BFF, SSE, or wire fields;
- a user-global default, per-conversation pin, or “always use” mode;
- raw provider/model/reasoning controls or reverse mapping from execution facts;
- provider-managed conversation state or continuation cursors;
- prompt assembly, cache scope, cache affinity, accounting, or ledger changes;
- mobile-native implementation, settings UI, toast, badge, or cache diagnostics;
- recovery of pre-cutover historical rows beyond their existing typed facts.

## 4. Final architecture

```text
GET /conversations/{id}/tree
  -> decoded selected_path + active branch
  -> useConversation
  -> inherited ChatProfileSelection from the causal assistant run

sessionStorage draft
  -> useChatDraft
  -> explicit ChatProfileSelection, if any

GET /llm-profiles
  -> useChatProfiles
  -> ChatComposer
  -> resolveChatProfileSelection
       Draft
       > Inherited
       > ProductDefault
       > explicit UnavailableReplacement
  -> controlled ChatProfilePicker
  -> buildChatRunBody
  -> POST /chat-runs
  -> durable ChatRun selection
```

Ownership:

| Concern | Sole owner |
|---|---|
| Historical product selection | `ChatRun.profile_id` / `reasoning_option_id` |
| Resolved provider/model/effort facts | `ChatRun` trust trail and LLM ledger |
| Active path and branch source | `useConversation` |
| Explicit unsent choice and send attempt | `useChatDraft` |
| Product portfolio/default/availability | `llm_profiles.py` via `useChatProfiles` |
| Ready-catalog precedence and validation | `resolveChatProfileSelection` |
| Profile/reasoning rendering and user input | `ChatProfilePicker` |
| Send payload | `buildChatRunBody` |

## 5. Capability contract

Move the shared selection type out of the picker:

```ts
export interface ChatProfileSelection {
  readonly profileId: string;
  readonly reasoningOptionId: string;
}

export interface InheritedChatProfileSelection {
  readonly selection: ChatProfileSelection;
  readonly assistantMessageId: string;
  readonly runId: string;
}

export type ResolvedChatProfileSelection =
  | { readonly kind: "Draft"; readonly selection: ChatProfileSelection }
  | {
      readonly kind: "Inherited";
      readonly selection: ChatProfileSelection;
      readonly assistantMessageId: string;
      readonly runId: string;
    }
  | { readonly kind: "ProductDefault"; readonly selection: ChatProfileSelection }
  | {
      readonly kind: "UnavailableReplacement";
      readonly source: "Draft" | "Inherited";
      readonly unavailableSelection: ChatProfileSelection;
      readonly selection: ChatProfileSelection;
    };
```

`resolveChatProfileSelection` is pure and total once the profile catalog is
ready. Precedence is exact:

1. structurally valid explicit draft selection;
2. causal inherited selection;
3. product default.

Each candidate is usable only when its profile exists and contains its reasoning
option. An unavailable Draft or Inherited candidate resolves to
`UnavailableReplacement` with the current product default.
This is explicit current-product behavior, not a legacy/compatibility fallback.

The product default must resolve exactly. Delete the existing `profiles[0]`
substitute. A ready same-system catalog with a missing default profile or default
reasoning option is a defect.

## 6. Causal source rules

`useConversation` derives at most one inherited candidate:

1. `branchDraft.parentMessageId` when branch mode is active;
2. otherwise the selected path's assistant leaf, including queued/running,
   complete, error, or cancelled;
3. otherwise no inherited candidate.

Read only `trust_trail.run.profile_id` and `reasoning_option_id`.

- Both present: emit `InheritedChatProfileSelection`.
- Both absent, or `run` absent: no inherited candidate; use ProductDefault.
- Exactly one present: defect.
- Do not scan backward to an older run.
- Do not choose by conversation-global timestamp.
- Do not infer from `provider`, `model_name`, or `reasoning_effort`.

The run created by `POST /chat-runs` already returns the selection in both
`data.run` and the assistant trust trail. The optimistic selected path therefore
becomes authoritative without a refetch.

## 7. Draft and picker composition

- `useChatDraft.profile` means explicit unsent choice only.
- Inherited/default selections are derived and never written to
  `sessionStorage`.
- User picker input writes the explicit draft choice.
- Successful send continues clearing the whole draft record.
- Each send attempt snapshots the exact sent profile pair and quote revision.
  Ambiguous reconciliation replays that snapshot and idempotency key even when
  the current catalog/default changed; the picker is replaced by one locked
  retry status while that outcome is unknown.
- The draft decoder accepts only the exact `ChatProfileSelection` object or
  `null`; malformed browser storage clears the record. No version decoder or
  legacy shape remains.

`ChatComposer` calls `useChatProfiles` and owns resolution. `ChatProfilePicker`
becomes a pure controlled renderer receiving the ready profiles, resolved
selection, and `onChange`. Delete its catalog fetch, mount-time default effect,
and local default helper.

## 8. API and persistence

No selection-specific server API or durable server-storage change. The existing
browser draft record hard-cuts to the exact attempt shape above; old/malformed
records clear.

The completed REST trust trail must project the `activation` already stored on
each `context_ref_added` event, matching the SSE payload and the owned frontend
type. This is strict transport parity required to rehydrate completed cited
messages; it adds no selection state, persistence, fallback, or new source of
truth.

Retain exactly:

- `GET /api/llm-profiles` for portfolio and current default;
- `GET /api/conversations/{id}/tree` for selected-path message trust trails;
- `POST /api/chat-runs` with `profile_id` and `reasoning_option_id`;
- `ChatRun` product-selection and resolved-execution snapshots;
- existing run idempotency, rerun, reconnect, and active-path persistence.

No `continuation_selection` field, conversation preference column, duplicate
profile snapshot, or client-owned provider enum is introduced.

If a second independent client later needs this policy, move the same resolver
behind one backend read projection; do not duplicate it across clients.

## 9. UX contract

- The existing native profile and reasoning selects display the resolved value.
- No new persistent “Continuing with” chrome.
- Valid inheritance is quiet.
- `UnavailableReplacement` renders one subdued inline `role="status"`:
  “The previous chat profile is no longer available. Using {default label}.”
- Do not expose the retired raw id, provider cache state, or operator facts.
- Profile privacy presentation remains unchanged and follows the effective
  selection.
- Picker focus, labels, keyboard behavior, and mobile reflow remain unchanged.

## 10. Hard cut and deletions

- Delete `ProfileSelection` from `ChatProfilePicker.tsx`; one shared
  `ChatProfileSelection` type remains.
- Delete `ChatProfilePicker`'s `useChatProfiles` call, default-emitting effect,
  `defaultSelection`, `isValidSelection`, and `profiles[0]` substitute.
- Delete any duplicate profile-validity/default derivation introduced by callers.
- Delete tests that assert mount-time mutation instead of visible resolved
  behavior.
- Replace stale docs saying the picker owns defaulting.
- Add no optional legacy prop, dual resolver, storage version branch, feature
  flag, compatibility alias, or reverse-mapping helper.

## 11. Files

### Create

- `apps/web/src/lib/conversations/chatProfileSelection.ts`
- `apps/web/src/lib/conversations/chatProfileSelection.test.ts`

### Modify

- `apps/web/src/components/chat/useConversation.ts`
- `apps/web/src/components/chat/Conversation.tsx`
- `apps/web/src/components/chat/ChatComposer.tsx`
- `apps/web/src/components/chat/ChatComposer.module.css`
- `apps/web/src/components/chat/ChatProfilePicker.tsx`
- `apps/web/src/components/chat/useChatDraft.ts`
- `apps/web/src/components/chat/useChatProfiles.ts`
- `apps/web/src/__tests__/components/ChatComposer.test.tsx`
- `apps/web/src/__tests__/components/Conversation.test.tsx`
- `apps/web/src/components/chat/useChatDraft.test.ts`
- `apps/web/src/components/chat/useConversation.test.tsx`
- `apps/web/src/lib/conversations/messageWire.test.ts`
- `e2e/seed-conversation-tree.py`
- `e2e/tests/chat-streaming.spec.ts`
- `e2e/tests/conversations.spec.ts`
- `e2e/tests/worker.ts`
- `python/nexus/schemas/conversation.py`
- `python/nexus/services/message_trust_trails.py`
- `python/tests/test_message_retrievals.py`
- `docs/modules/chat.md`
- `docs/cutovers/chat-interface-hard-cutover.md`
- `docs/cutovers/reader-highlight-quote-chat-hard-cutover.md`

### Explicitly unchanged

- chat-selection routes, request/response schemas, services, models, and
  migrations;
- database models and migrations for completed trust-trail parity;
- `buildChatRunBody`, chat-run execution, prompt assembly, provider runtime, and
  cache planner;
- branch API shapes.

## 12. Implementation order

1. Run the focused baseline; add failing behavior tests.
2. Add the shared types, strict draft decoder, causal-source derivation, and
   ready-catalog resolver.
3. Expose the inherited candidate from `useConversation`.
4. Move catalog/resolution ownership to `ChatComposer`; make the picker pure.
5. Delete the old effect/default path and contradicted tests/comments.
6. Update steady-state and predecessor docs; run negative scans and focused
   verification.

## 13. Acceptance criteria

- **AC-1:** Deep/High remains selected immediately after send, after completion,
  after pane remount, and after hard reload.
- **AC-2:** Normal continuation inherits from the active-path assistant leaf.
- **AC-3:** A branch draft inherits from its exact parent assistant; switching
  forks cannot leak another fork's selection.
- **AC-4:** An explicit unsent choice survives reload and wins until success.
- **AC-5:** A successful run becomes the next inheritance source without
  persisting a second preference.
- **AC-6:** New chat uses the exact server default.
- **AC-7:** Retired profile or reasoning selection produces the explicit
  unavailable notice and sends with the current default.
- **AC-8:** Missing/invalid current catalog default defects; no first-profile
  substitute exists.
- **AC-9:** Resolved provider/model/effort never drive selection.
- **AC-10:** Ambiguous-send idempotency, rerun, reconnect, privacy, Stop, branch,
  and quote behavior remain unchanged.
- **AC-11:** No selection API, database, prompt, cache-plan, or ledger change
  lands; completed REST trust trails retain their stored context activation.
- **AC-12:** Old defaulting helpers/effects, compatibility paths, stale tests,
  and contradicted docs are absent.

## 14. Verification and negative gates

- pure unit: precedence, branch source, exact-pair invariant, retirement, invalid
  product default, and no backward scan;
- browser component: effective native select values, explicit override,
  unavailable notice, privacy, reload/remount;
- real-stack E2E: non-default send → completion → reload, plus fork switch;
- focused TypeScript, ESLint, browser, and E2E gates;
- `git diff --check`;
- repository scan proves no `profiles[0]` profile-default substitute, picker
  default effect, duplicate resolver, or new persistence/API field.

## 15. Final-state laws

- Historical execution is immutable; next-turn intent is derived.
- Conversation continuity follows causal ancestry, not wall-clock recency.
- Draft intent wins; otherwise the causal run wins; otherwise the product
  default wins.
- Product ids select future behavior; provider facts explain past behavior.
- The current registry alone owns availability and default policy.
- One resolver, one picker, one send body, one durable run snapshot.
